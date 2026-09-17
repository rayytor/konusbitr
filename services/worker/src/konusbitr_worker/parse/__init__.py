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
5. **figures** — the embedded images, extracted, filtered and stored; captioned
   through the vision role when the upload asked for it with `llm: true`.
6. **thumbnails** — one WebP per page, streamed to storage.

Stages 3 and 4 are two readings of one document and they must not overlap. A
page belongs to exactly one tier, Docling's output for a page outside its tier
is dropped, and the merge below re-numbers the combined list so that element ids
remain a reading-order sort across both.

Since Phase 12.4 stages 3 through 6 run **per page batch** rather than once
over the document. The order of the stages within a batch is unchanged and so
is everything they do; what changes is that the loop around them has a commit
point. A batch's elements, page rows and figures are handed to the caller, the
caller writes them and records how far the job got, and the next batch starts
where the last one stopped. That is the whole of the resumability story, the
whole of the partial-readiness story, and — because a batch holds only its own
pages' bitmaps — the whole of the memory story. Stages 1 and 2 stay outside the
loop: they are about the file rather than about any page of it.

A document smaller than one batch runs exactly one iteration and is byte-for-byte
what Phase 12.2 produced, which is the overwhelming majority of uploads and the
reason the loop is invisible in the ordinary case.

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
from konusbitr_worker.parse.thumbnails import (
    THUMBNAIL_CONTENT_TYPE,
    render_thumbnails,
    thumbnail_key,
)
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
StageReporter = Callable[[JobStage], Awaitable[None]]

logger = get_logger("konusbitr.worker.parse")


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
    that is how the memory ceiling is met — and simply commits nothing, which
    is what the fixture tests do.

    `lang_list` and `llm` are `settings.langList` and `settings.llm` from the
    job payload, and they are here rather than in `Settings` because they are
    properties of the *upload* rather than of the deployment: both are hashed
    into `settings_hash`, so a document parsed with captions and the same
    document parsed without them are two cache entries and not one that quietly
    changed underneath a reader.

    `resume` is a previous run's committed state, and `should_cancel` is asked
    between pages. Both are the phase's two answers to the same question —
    which pages this run is responsible for — and both leave everything already
    committed exactly where it is.
    """
    ocr_options = _ocr_options(settings, lang_list=lang_list)
    recognizer = _recognizer(settings, ocr_options)
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
                ocr_available=recognizer is not None,
            )

        geometries = {page.page_no: page for page in inspection.pages}
        scanned_pages = set(await _pages_to_recognize(inspection, recognizer, settings))

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
        announced: set[JobStage] = set()

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
                    if JobStage.parsing not in announced:
                        announced.add(JobStage.parsing)
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
                    if JobStage.ocr not in announced:
                        announced.add(JobStage.ocr)
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

            recognized_pages = {result.page_no for result in recognized}
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
                    # text that no recogniser produced.
                    tier=PageTier.ocr if page_no in recognized_pages else PageTier.native,
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
            if recognized:
                accumulator.any_recognized = True
            if parsed.markdown:
                accumulator.markdown_parts.append(parsed.markdown)

            committed = accumulator.extend(
                elements=_ordered(parsed, recognized),
                pages=pages,
                images=[image.to_json() for image in images],
                last_page=batch.last_page,
            )

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

        _require_something_readable(accumulator.elements, recognized=bool(scanned_pages))

    artifact = accumulator.artifact()
    logger.info(
        "parse finished",
        extra={
            "pages": artifact.page_count,
            "elements": len(artifact.contents),
            "ocr_pages": sum(1 for page in artifact.pages if page.tier is PageTier.ocr),
            "figures": len(artifact.images),
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


def _ordered(parsed: DoclingParse, recognized: list[OcrPageResult]) -> list[ParsedElement]:
    """One batch's two tiers, interleaved into a single reading order.

    A page belongs to exactly one tier, so ordering by page number is enough to
    interleave them and each page's own order survives a stable sort. Numbering
    is not done here: the accumulator assigns ids from the running total so
    that `element_id`'s promise — a lexical sort is a reading-order sort —
    holds across every batch of the document rather than within one.
    """
    if not recognized:
        return list(parsed.contents)

    combined: list[ParsedElement] = list(parsed.contents)
    for result in recognized:
        combined.extend(result.elements_for_artifact(first_index=0))
    combined.sort(key=lambda element: element.page)
    return combined


async def _pages_to_recognize(
    inspection: DocumentInspection,
    recognizer: OcrPipeline | None,
    settings: Settings,
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
    logger.warning("OCR is enabled but no engine could be loaded")
    require_text_layer(inspection, settings.text_coverage_threshold)
    return []


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


async def _announce(on_stage: StageReporter | None, stage: JobStage) -> None:
    if on_stage is not None:
        await on_stage(stage)
