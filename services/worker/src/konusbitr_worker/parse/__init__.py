"""Parse pipeline: a PDF in, markdown plus located elements out.

The stages, in order, each of which is a module of its own:

1. **fetch** — pull the object out of storage and re-derive its SHA-256. The
   payload said what the bytes should hash to; a payload is a message, not an
   authority, so the bytes are checked rather than believed.
2. **inspect** — open with PDFium: readable, not encrypted, within the page
   ceiling, and — since Phase 12.1 — every page sorted into a tier by how much
   extractable text it carries. Cheap structural questions, asked before a
   layout model is loaded.
3. **convert** — Docling over the born-digital pages, then normalization into
   the artifact. Everything parser-shaped stops at that module's edge.
4. **recognise** — the OCR tier over the scanned ones, routed to an engine and
   a dictionary by the document's language. Skipped entirely when there are
   none, which is the ordinary case and must stay free.
5. **look** — Phase 12.3's VLM tier over the pages that asked for it, either
   because the upload said `quality: "advanced"` or because a recognised page
   came back below `TIER_FALLBACK_THRESHOLD`. Its reading of a page replaces
   the other tiers'.
6. **figures** — the embedded images, extracted, filtered and stored; captioned
   through the vision role when the upload asked for it with `llm: true`.
7. **thumbnails** — one WebP per page, streamed to storage.

Stages 3, 4 and 5 are three readings of one document and they must not overlap.
A page belongs to exactly one tier in the finished artifact: Docling's output
for a page outside its tier is dropped, the VLM's reading of a page supersedes
whichever tier read it first, and the merge below re-numbers the combined list
so that element ids remain a reading-order sort across all three.

The VLM tier is *layered on top of* the other two rather than replacing them,
and that is deliberate. A page the model could not read — a provider outage, a
rate limit, an answer that was not JSON — still has Docling's or the
recogniser's reading of it in hand, so the structure of one page degrades
instead of the document failing. It is also where the reconciliation's evidence
comes from: the same pass that produced the fallback produced the located words
the model is corrected against.

Since Phase 12.4 stages 3 through 7 run **per page batch** rather than once
over the document. The order of the stages within a batch is unchanged and so
is everything they do; what changes is that the loop around them has a commit
point. A batch's elements, page rows and figures are handed to the caller, the
caller writes them and records how far the job got, and the next batch starts
where the last one stopped. That is the whole of the resumability story, the
whole of the partial-readiness story, and — because a batch holds only its own
pages' bitmaps — the whole of the memory story. Stages 1 and 2 stay outside the
loop: they are about the file rather than about any page of it.

A document smaller than one batch runs exactly one iteration and is what Phase
12.3 produced, which is the overwhelming majority of uploads and the reason the
loop is invisible in the ordinary case. One thing genuinely crosses a batch
boundary and is handled where it is built: the **heading trail**. A section
title on page 3 scopes pages 4 and 5, so `_apply_section_paths` is recomputed
over everything accumulated so far rather than over the batch alone.

Progress is reported between them rather than inside them: a stage boundary is
something a person watching a spinner can be told about truthfully, and a
percentage invented inside a parser is not.

Every blocking step runs on a thread. The event loop this coroutine lives on is
also publishing progress and answering `/health`, and Docling and PDFium are
both synchronous and CPU-bound — a parse run inline would make a worker look
dead for the length of every document it processes.
"""

from __future__ import annotations

import asyncio
import tempfile
import time
from collections.abc import Awaitable, Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from konusbitr_worker.ai.vision import VisionRouter
from konusbitr_worker.contracts import JobErrorCode, JobStage
from konusbitr_worker.errors import JobCancelled, JobFailure
from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.artifact import (
    ElementType,
    PageTier,
    ParseArtifact,
    ParsedElement,
    ParsedPage,
)
from konusbitr_worker.parse.batching import (
    ParseAccumulator,
    ResumeState,
    page_batches,
)
from konusbitr_worker.parse.captions import caption_images
from konusbitr_worker.parse.docling_parser import DoclingParse, build_converter, convert
from konusbitr_worker.parse.geometry import PageGeometry
from konusbitr_worker.parse.images import (
    IMAGE_CONTENT_TYPE,
    ExtractedImage,
    ImageCandidate,
    extract_images,
    image_id,
    image_key,
)
from konusbitr_worker.parse.inspect import (
    DocumentInspection,
    inspect_pdf,
    require_text_layer,
)
from konusbitr_worker.parse.ocr import OcrOptions, OcrPageResult, OcrPipeline, ocr_pages
from konusbitr_worker.parse.storage import ObjectStore, sha256_of
from konusbitr_worker.parse.textlayer import TextWord, page_words
from konusbitr_worker.parse.thumbnails import (
    THUMBNAIL_CONTENT_TYPE,
    render_thumbnails,
    thumbnail_key,
)
from konusbitr_worker.parse.vlm import VlmOptions, VlmPageResult, read_pages
from konusbitr_worker.parse.vlm.reconcile import HIGH_CONFIDENCE_OCR_WORD, ReconciliationReport
from konusbitr_worker.scratch import ScratchSpace, collect
from konusbitr_worker.settings import Settings

__all__ = [
    "BatchOutcome",
    "BatchReporter",
    "CancelCheck",
    "ParseArtifact",
    "StageReporter",
    "parse_document",
]

#: How the pipeline is told a stage has begun. The parse decides *when*; the
#: caller decides what a person is told and where it is published, because a
#: progress message is product copy and a parser has no business writing it.
#:
#: The optional second argument is the one exception, and it exists because two
#: different things share the `ocr` stage: recognition and the VLM tier. The
#: caller cannot tell them apart — only the parse knows which it just started —
#: and "Recognising scanned pages" shown while a vision model reads a
#: born-digital magazine is a progress line that is simply false. The caller
#: still owns the default wording; this only lets the parse say *which* of its
#: two readings is running.
StageReporter = Callable[..., Awaitable[None]]

logger = get_logger("konusbitr.worker.parse")

#: What a person watching the bar is told while the VLM tier runs.
#:
#: Shares `JobStage.ocr` with recognition and says something different, because
#: they are different things: one is a machine reading a photograph of text, and
#: the other is a model working out what order a page is read in.
VLM_STAGE_MESSAGE = "Reading pages with a vision model"


@dataclass(frozen=True, slots=True)
class BatchOutcome:
    """One committed page batch, handed to the caller so it can persist it.

    Carries both halves on purpose. `elements` is what this batch produced and
    is what the caller chunks; `artifact` is the document as it now stands and
    is what the caller writes to `parse_results`. Deriving either from the
    other would mean either re-chunking the whole document every batch or
    storing a parse that only covers the last sixteen pages.
    """

    first_page: int
    last_page: int
    elements: list[ParsedElement]
    artifact: ParseArtifact
    #: Pages fully read so far, which is `last_page` — named separately because
    #: it is what `documents.pages_ready` is set from and the two would drift if
    #: the batching ever stopped being contiguous.
    pages_done: int
    page_count: int
    #: Chunks the document had before this batch, which is where this batch's
    #: ordinals begin. The caller returns the new total from `on_batch`, and
    #: the accumulator carries it to the next one.
    chunks_written: int


#: Called once per committed batch. Returns how many chunks the document has
#: after the caller has stored this batch, which is where the next batch's
#: ordinals begin.
BatchReporter = Callable[[BatchOutcome], Awaitable[int]]

#: Asked between pages and between batches. Synchronous, because it is also
#: consulted from inside the worker threads that do the recognition, where an
#: awaitable would need a loop that is not there. It must not block.
CancelCheck = Callable[[], bool]


async def parse_document(
    *,
    store: ObjectStore,
    settings: Settings,
    org_id: str,
    document_id: str,
    storage_key: str,
    content_hash: str,
    lang_list: Sequence[str] = (),
    llm: bool = False,
    quality: str = "standard",
    on_stage: StageReporter | None = None,
    batch_size: int | None = None,
    resume: ResumeState | None = None,
    on_batch: BatchReporter | None = None,
    should_cancel: CancelCheck | None = None,
    scratch: ScratchSpace | None = None,
) -> ParseArtifact:
    """Run the whole parse and return the artifact. Writes thumbnails; writes no rows.

    Persistence is the caller's, deliberately. This function is a pure-ish
    function of the bytes it fetches, which is what lets the fixture tests run
    it end to end without a database — and what keeps the idempotency rules,
    which are about *writes*, in the one place that does any. `on_batch` does
    not break that: it is a callback the caller supplies and this function never
    touches the database. Supplying none still reads the document in batches —
    that is how the memory ceiling is met — and simply commits nothing, which is
    what the fixture tests do.

    `lang_list`, `llm` and `quality` are `settings.langList`, `settings.llm` and
    `settings.quality` from the job payload, and they are here rather than in
    `Settings` because they are properties of the *upload* rather than of the
    deployment: all three are hashed into `settings_hash`, so a document parsed
    with captions and the same document parsed without them are two cache
    entries and not one that quietly changed underneath a reader. `quality` is
    the same story one step further on — an `advanced` parse and a `standard`
    parse of the same bytes are genuinely different artifacts, and the cache key
    already said so before this phase gave the distinction teeth.

    `resume` is a previous run's committed state, and `should_cancel` is asked
    between pages. Both are Phase 12.4's two answers to the same question —
    which pages this run is responsible for — and both leave everything already
    committed exactly where it is.
    """
    ocr_options = _ocr_options(settings, lang_list=lang_list)
    recognizer = _recognizer(settings, ocr_options)
    looker = _looker(settings, quality=quality)
    advanced = quality == "advanced" and looker is not None
    size = max(batch_size or settings.worker_page_batch_size, 1)

    with _temporary_pdf() as path:
        timings: dict[str, int] = {}
        with _timed(timings, "fetch"):
            await _announce(on_stage, JobStage.fetching)
            await store.download(storage_key, path)
            await _verify_hash(path, content_hash)

        with _timed(timings, "inspect"):
            await _announce(on_stage, JobStage.validating)
            inspection = await asyncio.to_thread(
                inspect_pdf,
                path,
                coverage_threshold=settings.text_coverage_threshold,
                max_pages=settings.max_pages,
                # A page a vision model is about to read is a page that will not
                # be parsed into silence, which is the whole of what `needs_ocr`
                # protects against. So an advanced parse satisfies the same
                # requirement a configured recogniser does.
                ocr_available=recognizer is not None or advanced,
            )

        _require_within_vlm_budget(inspection, settings, advanced=advanced)

        geometries = {page.page_no: page for page in inspection.pages}
        scanned_pages = set(
            await _pages_to_recognize(inspection, recognizer, settings, advanced=advanced)
        )

        accumulator = ParseAccumulator.resumed(inspection.page_count, resume)
        accumulator.timings.update(timings)
        if accumulator.last_processed_page:
            logger.info(
                "resuming a parse",
                extra={
                    "from_page": accumulator.last_processed_page + 1,
                    "pages": inspection.page_count,
                    "chunks": accumulator.chunks_written,
                },
            )

        # Pages the inspection tiered as imaged, whether or not a recogniser
        # reached them. An imaged page's one image *is* the page: extracting it
        # would duplicate the document, and captioning it would ask a vision
        # model to describe a photograph of text the OCR tier has already read.
        figure_skip = set(inspection.pages_in_tier(PageTier.ocr))
        # One converter for the document rather than one per batch: it holds
        # TableFormer's weights, and rebuilding it fifty-six times on a
        # 900-page filing costs minutes for an identical result.
        converter: Any | None = None
        # The language route is a document-level decision. Once `settings.
        # langList` or the first batch's text has settled it, later batches
        # inherit it rather than re-identifying from their own pages.
        language_resolved = bool(ocr_options.requested_languages)
        announced: set[str] = set()
        reconciliation = ReconciliationReport()
        looked_any = False
        #: Pages spent on the vision model so far, against the document budget.
        vlm_used = 0

        for batch in page_batches(
            page_count=inspection.page_count,
            scanned_pages=scanned_pages,
            batch_size=size,
            start_after=accumulator.last_processed_page,
        ):
            _raise_if_cancelled(should_cancel, accumulator, inspection.page_count)

            batch_timings: dict[str, int] = {}
            with _timed(batch_timings, "convert"):
                if batch.native:
                    if "parsing" not in announced:
                        announced.add("parsing")
                        await _announce(on_stage, JobStage.parsing)
                    converter = converter or await asyncio.to_thread(
                        build_converter, settings.worker_parse_threads
                    )
                    parsed = await asyncio.to_thread(
                        convert,
                        path,
                        geometries=geometries,
                        threads=settings.worker_parse_threads,
                        native_pages=batch.native,
                        converter=converter,
                    )
                else:
                    # Every page in this batch is a scan. Loading a layout model
                    # to find no text layer is the expensive way to learn what
                    # the inspection already measured.
                    parsed = DoclingParse(markdown="", contents=[])

            recognized: list[OcrPageResult] = []
            with _timed(batch_timings, "ocr"):
                if batch.scanned and recognizer is not None:
                    if "ocr" not in announced:
                        announced.add("ocr")
                        await _announce(on_stage, JobStage.ocr)
                    recognized = await asyncio.to_thread(
                        ocr_pages,
                        path,
                        sorted(batch.scanned),
                        geometries=geometries,
                        options=ocr_options,
                        pipeline=recognizer,
                        # The born-digital half of a mixed filing is what the
                        # language identifier reads, and it is free — it has
                        # already been parsed. A wholly scanned document has no
                        # such text and `ocr_pages` falls back to probing its
                        # first page.
                        sample=parsed.markdown or accumulator.markdown(),
                        resolved=language_resolved or None,
                        should_cancel=should_cancel,
                    )
                    language_resolved = True

            _raise_if_cancelled(should_cancel, accumulator, inspection.page_count)

            looked: list[VlmPageResult] = []
            with _timed(batch_timings, "vlm"):
                # Scoped to this batch's pages. The two routes into the tier are
                # unchanged — `advanced` reads everything, a badly-recognised
                # page escalates on its own — and both are evaluated against the
                # pages in hand, because the escalation decision needs *this*
                # batch's confidences and the budget is a document-level count
                # the helper already applies.
                vlm_pages = [
                    page_no
                    for page_no in _pages_to_look_at(
                        inspection,
                        recognized,
                        settings,
                        advanced=advanced,
                        enabled=looker is not None,
                        # The escalation cap is a *document* budget, and this
                        # loop asks per batch — so what is left of it is passed
                        # down rather than the whole of it. Without this, a
                        # 900-page filing with two bad pages in each of its
                        # fifty-six batches would quietly buy a hundred and
                        # twelve model calls against a ceiling of fifty. An
                        # `advanced` parse is unaffected: its page count was
                        # checked against the ceiling before the loop began.
                        budget=settings.max_vlm_pages_per_job - vlm_used,
                    )
                    if batch.first_page <= page_no <= batch.last_page
                ]
                if vlm_pages and looker is not None:
                    # No stage of its own. `JobStage` is the cross-runtime
                    # contract and `STAGE_PERCENT` is what a reconnecting
                    # browser replays from, so adding a stage is a contract
                    # change for a tier that runs on a minority of documents.
                    # `ocr` is where it sits on the bar — the same position,
                    # between parsing and chunking.
                    #
                    # The *message* is its own, because the stage's default one
                    # is about recognising scans and this is frequently a vision
                    # model reading a perfectly legible magazine. A progress line
                    # a reader can see has to be true.
                    if "vlm" not in announced:
                        announced.add("vlm")
                        await _announce(on_stage, JobStage.ocr, VLM_STAGE_MESSAGE)
                    truth = await _reconciliation_truth(
                        path,
                        vlm_pages,
                        geometries=geometries,
                        inspection=inspection,
                        recognized=recognized,
                    )
                    looked = await read_pages(
                        path,
                        vlm_pages,
                        geometries=geometries,
                        truth=truth,
                        router=looker,
                        options=_vlm_options(settings),
                    )
                    vlm_used += len(vlm_pages)
                    for result in looked:
                        reconciliation.add(result.report)

            _raise_if_cancelled(should_cancel, accumulator, inspection.page_count)

            looked_pages = {result.page_no for result in looked if result.elements}
            recognized_pages = {result.page_no for result in recognized} - looked_pages
            looked_any = looked_any or bool(looked_pages)

            pages = [
                ParsedPage(
                    page_no=page_no,
                    width=geometries[page_no].width,
                    height=geometries[page_no].height,
                    rotation=geometries[page_no].rotation,
                    # Tiered by what actually ran, not by what was measured. A
                    # page the inspection called `ocr` and that nothing then
                    # read is a page the standard parser handled, and recording
                    # it otherwise would badge it in the viewer as recognised
                    # text that no recogniser produced. A page the vision model
                    # read is `vlm` however it was tiered before, because that is
                    # the reading that survived into `contents`.
                    tier=_tier_of(page_no, looked_pages, recognized_pages),
                )
                for page_no in batch.pages
                if page_no in geometries
            ]
            _apply_confidence(pages, recognized)

            with _timed(batch_timings, "figures"):
                images = await _extract_figures(
                    path,
                    store=store,
                    settings=settings,
                    org_id=org_id,
                    document_id=document_id,
                    geometries=geometries,
                    skip_pages=figure_skip,
                    only_pages=set(batch.pages),
                    seen=accumulator.seen_images,
                    start_index=len(accumulator.images),
                    llm=llm,
                )

            with _timed(batch_timings, "thumbnails"):
                # No stage announcement. `ProgressReporter` clamps the
                # percentage to be monotonic, so announcing `persisting` (95%)
                # here — before `chunking` (70%) and `embedding` (85%) had
                # happened — pinned the bar at 95% for the whole of the chunking
                # and embedding that follow. Thumbnails belong to `parsing`.
                await _write_thumbnails(
                    path,
                    store=store,
                    settings=settings,
                    org_id=org_id,
                    document_id=document_id,
                    pages=pages,
                    scratch=scratch,
                )

            for stage, milliseconds in batch_timings.items():
                accumulator.add_timing(stage, milliseconds)
            if recognized or looked:
                accumulator.any_recognized = True
            if parsed.markdown and not looked_pages:
                accumulator.markdown_parts.append(parsed.markdown)

            committed = accumulator.extend(
                elements=_ordered(parsed, recognized, looked),
                pages=pages,
                images=[image.to_json() for image in images],
                last_page=batch.last_page,
            )

            if looked_any:
                # Over everything accumulated, not over this batch. A heading is
                # a claim about the *document*: a section title the vision model
                # found on page 3 scopes the born-digital pages 4 and 5 that
                # follow it, and a trail rebuilt per batch would reset at every
                # sixteenth page. The elements handed to the caller are the same
                # objects, so the batch sees its own corrected trail.
                _apply_section_paths(accumulator.elements)

            if on_batch is not None:
                accumulator.chunks_written = await on_batch(
                    BatchOutcome(
                        first_page=batch.first_page,
                        last_page=batch.last_page,
                        elements=committed,
                        artifact=accumulator.artifact(),
                        pages_done=batch.last_page,
                        page_count=inspection.page_count,
                        chunks_written=accumulator.chunks_written,
                    )
                )

            # The bitmaps this batch decoded are unreachable from here, and
            # large enough that waiting for the collector to notice is the
            # difference between a worker that stays under two gigabytes on a
            # 900-page scan and one the kernel kills at page 400.
            collect()

        _require_something_readable(
            accumulator.elements,
            recognized=bool(scanned_pages) or advanced,
        )

    artifact = accumulator.artifact()
    logger.info(
        "parse finished",
        extra={
            "pages": artifact.page_count,
            "elements": len(artifact.contents),
            "quality": quality,
            "ocr_pages": sum(1 for page in artifact.pages if page.tier is PageTier.ocr),
            "vlm_pages": sum(1 for page in artifact.pages if page.tier is PageTier.vlm),
            "figures": len(artifact.images),
            "reconciliation": reconciliation.to_json(),
            "timings_ms": artifact.timings,
        },
    )
    return artifact


def _raise_if_cancelled(
    should_cancel: CancelCheck | None,
    accumulator: ParseAccumulator,
    page_count: int,
) -> None:
    """Stop the parse if somebody asked it to, keeping what is already committed.

    Raised rather than returned, because there is no honest artifact to return:
    a half-read document handed back as a complete one is precisely the silent
    emptiness the pipeline's refusals exist to prevent. The pages already
    committed stay committed — they were written properly, with their chunks
    and their vectors — so a cancelled document is a short one rather than a
    broken one.
    """
    if should_cancel is not None and should_cancel():
        raise JobCancelled(
            pages_done=accumulator.last_processed_page,
            pages_total=page_count,
        )


def _ordered(
    parsed: DoclingParse,
    recognized: list[OcrPageResult],
    looked: list[VlmPageResult],
) -> list[ParsedElement]:
    """One batch's tiers, interleaved into a single reading order.

    A page ends up belonging to exactly one tier, so ordering by page number is
    enough to interleave them and each page's own order survives a stable sort.
    Numbering is not done here: the accumulator assigns ids from the running
    total so that `element_id`'s promise — a lexical sort is a reading-order
    sort — holds across every batch of the document rather than within one.

    **The VLM tier supersedes.** A page it read successfully has its other
    readings dropped outright, not merged with them: the same paragraph present
    twice would be retrieved twice, cited from whichever won, and highlighted at
    two slightly different rectangles. A page it *failed* on keeps whatever
    Docling or the recogniser made of it, which is the fallback that keeps a
    provider outage from costing a document.
    """
    if not recognized and not looked:
        return list(parsed.contents)

    superseded = {result.page_no for result in looked if result.elements}

    combined: list[ParsedElement] = [
        element for element in parsed.contents if element.page not in superseded
    ]
    for result in recognized:
        if result.page_no in superseded:
            continue
        combined.extend(result.elements_for_artifact(first_index=0))
    for vlm_result in looked:
        combined.extend(vlm_result.elements_for_artifact(first_index=0))
    combined.sort(key=lambda element: element.page)
    return combined


async def _pages_to_recognize(
    inspection: DocumentInspection,
    recognizer: OcrPipeline | None,
    settings: Settings,
    *,
    advanced: bool = False,
) -> list[int]:
    """The pages the OCR tier will actually read, and nothing speculative.

    Two questions, asked in this order for one reason: **the second is
    expensive.** Loading RapidOCR means `onnxruntime` building three graphs,
    which costs a few hundred milliseconds and tens of megabytes — and a library
    of born-digital PDFs would pay it on every document to learn something no
    page of them needs. So the tiering is consulted first and the engines are
    only woken when a page is going to be handed to them.

    "Configured" and "working" are different states, and only this function has
    asked both. A deployment with `OCR_ENABLED=true` whose engines will not load
    must refuse a scan with `needs_ocr` exactly as Phase 07 did — `inspect` did
    not refuse it, because as far as it knew a recogniser was coming.
    """
    if recognizer is None:
        return []

    scanned = inspection.pages_in_tier(PageTier.ocr)
    if not scanned:
        return []

    if await asyncio.to_thread(recognizer.available):
        return scanned

    # Configured, and not usable. Falls back to the Phase 07 verdict: refuse a
    # document that is mostly imaged, and let a scanned signature page inside an
    # otherwise readable report through to the standard parser, which is what
    # used to happen to it.
    #
    # Unless a vision model is about to read those pages. `advanced` is the one
    # state in which an unloadable recogniser costs the document nothing: the
    # scanned pages have a reader, it is simply a different one, and refusing
    # here would fail a document this deployment can in fact parse.
    logger.warning("OCR is enabled but no engine could be loaded")
    if not advanced:
        require_text_layer(inspection, settings.text_coverage_threshold)
    return []


def _require_within_vlm_budget(
    inspection: DocumentInspection,
    settings: Settings,
    *,
    advanced: bool,
) -> None:
    """Refuse an advanced parse of a document longer than the VLM page ceiling.

    Terminal, not retryable: no number of attempts makes a document shorter. It
    is also checked at intake, in `apps/web/src/lib/ingest/documents.ts`, which
    is where a person actually sees it — this is the second half of the same
    rule, here because a job payload arrives from a queue rather than from the
    endpoint that validated it, and because `MAX_VLM_PAGES_PER_JOB` can be
    lowered between the two.

    Refusing rather than truncating to the first fifty pages is the point of the
    guardrail. A job that reads fifty pages of a four-hundred-page filing and
    calls the result a parse has spent the money the ceiling was meant to save
    *and* produced a document that is silently missing seven eighths of itself.
    """
    if not advanced:
        return
    ceiling = settings.max_vlm_pages_per_job
    if inspection.page_count <= ceiling:
        return

    raise JobFailure(
        JobErrorCode.too_many_pages,
        f"That document has {inspection.page_count} pages, and the advanced parser "
        f"reads at most {ceiling} in one job. Parse it at standard quality, or "
        "split it into shorter documents.",
    )


def _pages_to_look_at(
    inspection: DocumentInspection,
    recognized: list[OcrPageResult],
    settings: Settings,
    *,
    advanced: bool,
    enabled: bool,
    budget: int | None = None,
) -> list[int]:
    """Which pages the vision model reads: all of them, or the badly-read ones.

    Two routes in, and they are deliberately different shapes.

    **The upload asked.** `quality: "advanced"` means every page, because the
    thing being bought is *document-level* structure — a reading order that runs
    across a spread, a heading hierarchy that holds from the first page to the
    last. Reading a subset would produce a document whose section paths change
    tier half-way through. The page count was already checked against the
    ceiling, so this cannot be unbounded.

    **A page was read badly.** Escalation is per page and opportunistic: a
    recognised page below `TIER_FALLBACK_THRESHOLD` is one where roughly two
    words in five were guesses, and looking at it is worth a model call. This
    route is *capped rather than refused* — the document is fine, and a filing
    with two hundred illegible pages should get its best fifty rather than an
    error — which is the opposite of the rule above, for the opposite reason:
    nobody asked for this and nobody is waiting to confirm a price.

    `budget` is what is left of that cap. It exists because the caller asks
    once per page batch and the cap is a property of the *document*: passing
    the full ceiling every time would let a long filing with a couple of bad
    pages per batch spend several times what the ceiling allows, one batch at a
    time, with nothing in the log to say so.
    """
    if not enabled:
        return []

    if advanced:
        return [page.page_no for page in inspection.pages]

    threshold = settings.tier_fallback_threshold
    if threshold <= 0:
        return []

    escalated = sorted(result.page_no for result in recognized if result.confidence < threshold)
    if not escalated:
        return []

    ceiling = settings.max_vlm_pages_per_job if budget is None else max(budget, 0)
    if len(escalated) > ceiling:
        logger.warning(
            "more pages were read badly than the VLM budget allows; taking the first",
            extra={"escalated": len(escalated), "budget": ceiling},
        )
        escalated = escalated[:ceiling]
    if not escalated:
        return []

    logger.info(
        "escalating badly-recognised pages to the vision model",
        extra={"pages": len(escalated), "threshold": threshold},
    )
    return escalated


async def _reconciliation_truth(
    path: Path,
    pages: Sequence[int],
    *,
    geometries: dict[int, PageGeometry],
    inspection: DocumentInspection,
    recognized: list[OcrPageResult],
) -> dict[int, list[TextWord]]:
    """The located characters each page's VLM reading will be corrected against.

    Two sources, chosen per page by the tier the page was in before the vision
    model saw it, and the choice is the phase's own diagram:

    **A born-digital page has a text layer**, and the text layer is not a
    reading of the page — it *is* the page. Those characters win outright.

    **A scanned page has whatever the recogniser was confident about.** Only the
    confident words: correcting a model's guess with a recogniser's guess turns
    two uncertainties into one confident wrong answer, which is worse than
    leaving the model's reading flagged as ungrounded. See
    `HIGH_CONFIDENCE_OCR_WORD`.

    A page with neither gets an empty list, which is a supported state and comes
    back as `grounded=False` elements — the honest statement that what the page
    says is the model's word alone.
    """
    wanted = set(pages)
    by_page = {result.page_no: result for result in recognized}

    native = [
        page_no
        for page_no in pages
        if page_no not in by_page and inspection.tier_of(page_no) is PageTier.native
    ]
    truth: dict[int, list[TextWord]] = {}
    if native:
        truth |= await asyncio.to_thread(page_words, path, native, geometries=geometries)

    for page_no, result in by_page.items():
        if page_no not in wanted:
            continue
        truth[page_no] = [
            TextWord(text=word.text, bbox=word.bbox)
            for word in result.words
            if word.confidence >= HIGH_CONFIDENCE_OCR_WORD
        ]

    return truth


def _tier_of(page_no: int, looked: set[int], recognized: set[int]) -> PageTier:
    """The tier a page's stored text actually came from."""
    if page_no in looked:
        return PageTier.vlm
    if page_no in recognized:
        return PageTier.ocr
    return PageTier.native


def _vlm_options(settings: Settings) -> VlmOptions:
    return VlmOptions(
        dpi=settings.vlm_dpi,
        max_tokens=settings.vlm_max_tokens,
        concurrency=settings.vlm_concurrency,
    )


def _looker(settings: Settings, *, quality: str) -> VisionRouter | None:
    """The vision router for the VLM tier, or `None` when the tier cannot run.

    `None` for three quite different reasons, and only one of them is worth a
    warning:

    - `VLM_ENABLED=false`. An operator's decision, silently honoured.
    - Nothing asked for it: `quality` is `standard` and escalation is switched
      off with `TIER_FALLBACK_THRESHOLD=0`. Building a router to use it on no
      page would resolve a model and open a circuit breaker for nothing.
    - **No vision model is configured, and the upload asked for `advanced`.**
      That one is logged, because the reader asked for something they are not
      getting. The document still parses at standard quality rather than
      failing: intake refuses `advanced` when no vision role is configured, so
      reaching here means the configuration changed between the upload and the
      job, and losing the document over that would be the wrong trade.
    """
    if not settings.vlm_enabled:
        return None
    if quality != "advanced" and settings.tier_fallback_threshold <= 0:
        return None

    router = VisionRouter.configured(settings)
    if router is None and quality == "advanced":
        logger.warning(
            "an advanced parse was requested but no vision model is configured; "
            "parsing at standard quality instead"
        )
    return router


def _require_something_readable(contents: list[ParsedElement], *, recognized: bool) -> None:
    """Refuse a document that came back with nothing on any page.

    The Phase 07 invariant, moved to where it still applies. `inspect` refuses a
    scan when nothing can read it; this refuses the case one step further on —
    a recogniser *did* run, over a page it could not read, and produced no
    words. A document with no locatable elements cannot be cited from, and a
    chat over it answers confidently out of an empty index, which is the single
    failure this product exists to prevent.

    Only raised when recognition actually ran. A born-digital document with no
    elements never gets this far: its coverage is zero on every page and
    `inspect` has already refused it, and raising here as well would replace a
    precise message with a vaguer one.
    """
    if contents or not recognized:
        return

    raise JobFailure(
        JobErrorCode.needs_ocr,
        "Text recognition ran over that document and found no readable text. "
        "It may be a blank scan, a photograph of something other than a page, "
        "or too faint to read — try a higher-quality scan.",
    )


def _recognizer(settings: Settings, options: OcrOptions) -> OcrPipeline | None:
    """The OCR tier for this job, or `None` when it is switched off.

    Built once per document rather than once per page: `onnxruntime` loading
    two graphs costs a few hundred milliseconds and tens of megabytes, and a
    fifty-page scan would otherwise pay it fifty times. Built even when the
    document turns out to have no scanned pages, because the engines are lazy
    inside — constructing this object loads nothing.

    It is built before the language is known, and that is deliberate rather
    than an ordering accident: `_pages_to_recognize` has to ask whether *any*
    engine can run before Docling is started, and the answer to that does not
    depend on which dictionary will be loaded. `OcrPipeline.retune` adopts the
    resolved plan later and rebuilds only what actually changed.
    """
    if not settings.ocr_enabled:
        return None
    return OcrPipeline(options)


def _ocr_options(settings: Settings, *, lang_list: Sequence[str] = ()) -> OcrOptions:
    return OcrOptions(
        dpi=settings.ocr_dpi,
        fallback_threshold=settings.ocr_fallback_threshold,
        low_confidence_threshold=settings.ocr_low_confidence_threshold,
        deskew_enabled=settings.ocr_deskew,
        fallback_enabled=settings.ocr_fallback_enabled,
        languages=settings.ocr_languages,
        threads=settings.worker_parse_threads,
        requested_languages=tuple(lang_list),
        model_dir=settings.ocr_model_dir,
        tables_enabled=settings.ocr_tables_enabled,
    )


def _apply_section_paths(elements: list[ParsedElement]) -> None:
    """Rebuild every element's heading trail over the merged document.

    Only when the VLM tier contributed, and then for *every* element rather than
    only its own. A heading is a claim about the document, not about the page it
    sits on: a section title the vision model found on page 3 scopes the
    born-digital pages 4 and 5 that follow it, and Docling — which was never
    shown page 3 — cannot know that. Recomputing the trail across the merged
    list is the only way the two halves agree about where in the document a
    passage came from, which is what `sectionPath` puts in every chunk header.

    The stack rule is Docling's own: a heading closes every open section at or
    below its level, and an element's trail is the sections *above* it, so a
    heading is not inside itself.
    """
    stack: list[tuple[int, str]] = []
    for element in elements:
        level = element.level if element.type is ElementType.heading else None
        if level is not None:
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, element.text.strip()))
        element.section_path = [
            heading for depth, heading in stack if level is None or depth < level
        ]


def _apply_confidence(pages: list[ParsedPage], recognized: list[OcrPageResult]) -> None:
    """Record each recognised page's confidence and engine on its page row."""
    by_page = {page.page_no: page for page in pages}
    for result in recognized:
        page = by_page.get(result.page_no)
        if page is None:  # pragma: no cover - the inspection produced both lists
            continue
        page.ocr_confidence = result.confidence
        page.ocr_engine = result.engine or None


async def _extract_figures(
    path: Path,
    *,
    store: ObjectStore,
    settings: Settings,
    org_id: str,
    document_id: str,
    geometries: dict[int, PageGeometry],
    skip_pages: set[int],
    only_pages: set[int] | None = None,
    seen: set[str] | None = None,
    start_index: int = 0,
    llm: bool = False,
) -> list[ExtractedImage]:
    """Extract, store and — when asked — caption the document's figures.

    Extraction runs on every document; captioning runs only when the upload set
    `llm: true` *and* a vision role is configured. The split is the phase's:
    getting a chart out of a PDF and knowing where it sits costs nothing and
    makes the viewer able to show it, while describing it costs a model call
    per figure and sends pixels to a provider.

    Uploaded in batches, as thumbnails are, so that neither every bitmap in a
    slide deck nor every outstanding upload is held at once. The candidates for
    a batch are kept only until that batch is captioned — a figure's PNG is
    megabytes, and a two-hundred-figure deck held whole would be a worker's
    memory ceiling.

    A figure that cannot be stored does not fail the document. The parse of the
    text is the thing the upload was for; a bucket that refused one image is
    worth a warning and not worth the reader losing the parse.
    """
    if not settings.figures_enabled:
        return []

    remaining = settings.figure_max_per_document - start_index
    if remaining <= 0:
        return []

    router = VisionRouter.configured(settings) if llm else None
    candidates = extract_images(
        path,
        geometries=geometries,
        skip_pages=skip_pages,
        # One batch's pages, and the document's running digest set. The
        # deduplication that stores a letterhead once has to span the whole
        # document rather than restart every sixteen pages, and the per-document
        # ceiling has to be a ceiling on the document rather than on each batch.
        only_pages=only_pages,
        seen=seen,
        min_edge=settings.figure_min_edge,
        limit=remaining,
    )

    stored: list[ExtractedImage] = []
    batch: list[tuple[ExtractedImage, ImageCandidate]] = []
    batch_size = max(settings.worker_parse_threads, 1)

    while True:
        produced = await asyncio.to_thread(_take, candidates, batch_size)
        if not produced:
            break

        batch.clear()
        for candidate in produced:
            index = start_index + len(stored) + 1
            key = image_key(org_id, document_id, index)
            try:
                await store.put_bytes(key, candidate.data, content_type=IMAGE_CONTENT_TYPE)
            except JobFailure:
                logger.warning(
                    "could not store an extracted figure",
                    extra={"page": candidate.page, "document_id": document_id},
                )
                continue
            image = ExtractedImage(
                id=image_id(index),
                page=candidate.page,
                bbox=candidate.bbox,
                width=candidate.width,
                height=candidate.height,
                storage_key=key,
            )
            stored.append(image)
            batch.append((image, candidate))

        await caption_images(batch, router=router)

    if stored:
        logger.info(
            "figures extracted",
            extra={"figures": len(stored), "captioned": sum(1 for i in stored if i.caption)},
        )
    return stored


async def _write_thumbnails(
    path: Path,
    *,
    store: ObjectStore,
    settings: Settings,
    org_id: str,
    document_id: str,
    pages: list[ParsedPage],
    scratch: ScratchSpace | None = None,
) -> None:
    """Render and upload a thumbnail for each of this batch's pages.

    Rendered on a thread in small groups and uploaded from the loop in between,
    so that neither a batch's bitmaps nor a batch's uploads are ever all
    outstanding at once.

    `scratch` is the disk-spill half of the memory ceiling. When it is given,
    each encoded WebP is written to the job's scratch directory and uploaded
    from there rather than being held in a list — so the bytes in memory at any
    moment are one page's, not a group's. The file is unlinked as soon as it
    has been uploaded, and the whole directory is removed however the job ends;
    a scratch directory cleaned only in the happy path is a disk that fills
    silently over a week and then fails at everything at once.
    """
    by_page = {page.page_no: page for page in pages}
    renderer = render_thumbnails(
        path,
        max_edge=settings.worker_thumbnail_max_edge,
        pages=sorted(by_page),
    )
    group_size = max(settings.worker_parse_threads, 1)

    while True:
        group = await asyncio.to_thread(_take_spilled, renderer, group_size, scratch)
        if not group:
            return
        for page_no, image, spilled in group:
            key = thumbnail_key(org_id, document_id, page_no)
            try:
                payload = spilled.read_bytes() if spilled is not None else image
                await store.put_bytes(key, payload, content_type=THUMBNAIL_CONTENT_TYPE)
            finally:
                if spilled is not None and scratch is not None:
                    scratch.release(spilled)
            page = by_page.get(page_no)
            if page is not None:
                page.thumbnail_key = key


def _take(iterator: Iterator[tuple[int, bytes]], count: int) -> list[tuple[int, bytes]]:
    """Pull up to `count` items off a generator, on whatever thread we are on."""
    items: list[tuple[int, bytes]] = []
    for _ in range(count):
        try:
            items.append(next(iterator))
        except StopIteration:
            break
    return items


def _take_spilled(
    iterator: Iterator[tuple[int, bytes]],
    count: int,
    scratch: ScratchSpace | None,
) -> list[tuple[int, bytes, Path | None]]:
    """`_take`, but writing each rendered page to disk when there is a scratch space.

    The returned `bytes` is empty whenever the third element is a path: the
    whole point is that the encoded page is *not* in memory, and returning both
    would defeat it. A caller with no scratch space gets the bytes and a `None`,
    which is the shape the tests and any small document use.
    """
    items: list[tuple[int, bytes, Path | None]] = []
    for _ in range(count):
        try:
            page_no, image = next(iterator)
        except StopIteration:
            break
        if scratch is None:
            items.append((page_no, image, None))
            continue
        spilled = scratch.page_path(page_no)
        spilled.write_bytes(image)
        items.append((page_no, b"", spilled))
    return items


async def _verify_hash(path: Path, expected: str) -> None:
    """Re-derive the digest and refuse the job if it disagrees with the payload.

    Terminal, not retryable. The object under that key is not the object the
    job was written for — it was replaced, or the payload is stale — and
    parsing it anyway would file one document's parse under another document's
    cache key, which is the one mistake the docId cache cannot recover from.
    """
    actual = await asyncio.to_thread(sha256_of, path)
    if actual != expected:
        raise JobFailure(
            JobErrorCode.content_hash_mismatch,
            "The stored file does not match the one this job was created for.",
        )


@contextmanager
def _temporary_pdf() -> Iterator[Path]:
    """A scratch file that is removed however the parse ends.

    A temp directory rather than a bare temp file so that nothing a parser
    decides to write alongside its input outlives the job — a worker that
    accumulates 500MB documents in `/tmp` fills a disk quietly and then fails
    at everything at once.
    """
    with tempfile.TemporaryDirectory(prefix="konusbitr-parse-") as directory:
        yield Path(directory) / "original.pdf"


@contextmanager
def _timed(timings: dict[str, int], stage: str) -> Iterator[None]:
    """Record a stage's wall-clock milliseconds.

    Instrumentation, not decoration: the phase budget is a 50-page text PDF
    ready in under 20 seconds, and a regression that does not say *which* stage
    slowed down costs an afternoon to localise.
    """
    started = time.perf_counter()
    try:
        yield
    finally:
        timings[stage] = int((time.perf_counter() - started) * 1000)


async def _announce(
    on_stage: StageReporter | None,
    stage: JobStage,
    message: str | None = None,
) -> None:
    if on_stage is None:
        return
    if message is None:
        await on_stage(stage)
    else:
        await on_stage(stage, message)
