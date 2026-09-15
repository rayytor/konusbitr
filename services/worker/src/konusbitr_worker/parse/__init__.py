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
from pathlib import Path

from konusbitr_worker.ai.vision import VisionRouter
from konusbitr_worker.contracts import JobErrorCode, JobStage
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.artifact import (
    PageTier,
    ParseArtifact,
    ParsedElement,
    ParsedPage,
    element_id,
    markdown_from_elements,
)
from konusbitr_worker.parse.captions import caption_images
from konusbitr_worker.parse.docling_parser import DoclingParse, convert
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
from konusbitr_worker.settings import Settings

__all__ = ["ParseArtifact", "StageReporter", "parse_document"]

#: How the pipeline is told a stage has begun. The parse decides *when*; the
#: caller decides what a person is told and where it is published, because a
#: progress message is product copy and a parser has no business writing it.
StageReporter = Callable[[JobStage], Awaitable[None]]

logger = get_logger("konusbitr.worker.parse")


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
) -> ParseArtifact:
    """Run the whole parse and return the artifact. Writes thumbnails; writes no rows.

    Persistence is the caller's, deliberately. This function is a pure-ish
    function of the bytes it fetches, which is what lets the fixture tests run
    it end to end without a database — and what keeps the idempotency rules,
    which are about *writes*, in the one place that does any.

    `lang_list` and `llm` are `settings.langList` and `settings.llm` from the
    job payload, and they are here rather than in `Settings` because they are
    properties of the *upload* rather than of the deployment: both are hashed
    into `settings_hash`, so a document parsed with captions and the same
    document parsed without them are two cache entries and not one that quietly
    changed underneath a reader.
    """
    timings: dict[str, int] = {}
    ocr_options = _ocr_options(settings, lang_list=lang_list)
    recognizer = _recognizer(settings, ocr_options)

    with _temporary_pdf() as path:
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
        scanned_pages = await _pages_to_recognize(inspection, recognizer, settings)
        native_pages = {
            page.page_no for page in inspection.pages if page.page_no not in set(scanned_pages)
        }

        with _timed(timings, "convert"):
            await _announce(on_stage, JobStage.parsing)
            if native_pages:
                parsed = await asyncio.to_thread(
                    convert,
                    path,
                    geometries=geometries,
                    threads=settings.worker_parse_threads,
                    native_pages=native_pages,
                )
            else:
                # Every page is a scan. Loading a layout model to find no text
                # layer on any page of the document is the expensive way to
                # learn what the inspection already measured.
                logger.info("no born-digital pages; skipping the layout parser")
                parsed = DoclingParse(markdown="", contents=[])

        recognized: list[OcrPageResult] = []
        with _timed(timings, "ocr"):
            if scanned_pages and recognizer is not None:
                await _announce(on_stage, JobStage.ocr)
                recognized = await asyncio.to_thread(
                    ocr_pages,
                    path,
                    scanned_pages,
                    geometries=geometries,
                    options=ocr_options,
                    pipeline=recognizer,
                    # The born-digital half of a mixed filing is what the
                    # language identifier reads, and it is free — it has already
                    # been parsed. A wholly scanned document has no such text
                    # and `ocr_pages` falls back to probing its first page.
                    sample=parsed.markdown,
                )

        contents, markdown = _merge(parsed, recognized)
        _require_something_readable(contents, recognized=bool(scanned_pages))
        recognized_pages = {result.page_no for result in recognized}

        pages = [
            ParsedPage(
                page_no=geometry.page_no,
                width=geometry.width,
                height=geometry.height,
                rotation=geometry.rotation,
                # Tiered by what actually ran, not by what was measured. A page
                # the inspection called `ocr` and that nothing then read is a
                # page the standard parser handled, and recording it otherwise
                # would badge it in the viewer as recognised text that no
                # recogniser produced.
                tier=PageTier.ocr if geometry.page_no in recognized_pages else PageTier.native,
            )
            for geometry in inspection.pages
        ]
        _apply_confidence(pages, recognized)

        with _timed(timings, "figures"):
            images = await _extract_figures(
                path,
                store=store,
                settings=settings,
                org_id=org_id,
                document_id=document_id,
                geometries=geometries,
                # An imaged page's one image *is* the page. Extracting it would
                # duplicate the document, and captioning it would ask a vision
                # model to describe a photograph of text the OCR tier has
                # already read properly.
                #
                # The set is every page the *inspection* tiered as imaged, not
                # only the ones a recogniser reached: a scan on a deployment
                # with no engine installed is still a scan, and the page-area
                # filter downstream is a backstop rather than the rule.
                skip_pages=set(inspection.pages_in_tier(PageTier.ocr)),
                llm=llm,
            )

        with _timed(timings, "thumbnails"):
            # No stage announcement. `ProgressReporter` clamps the percentage
            # to be monotonic, so announcing `persisting` (95%) here — before
            # `chunking` (70%) and `embedding` (85%) had happened — pinned the
            # bar at 95% for the whole of the chunking and embedding that
            # follow. Thumbnails belong to `parsing`, which is what the caller
            # has already announced.
            await _write_thumbnails(
                path,
                store=store,
                settings=settings,
                org_id=org_id,
                document_id=document_id,
                pages=pages,
            )

    artifact = ParseArtifact(
        markdown=markdown,
        page_count=inspection.page_count,
        contents=contents,
        pages=pages,
        images=[image.to_json() for image in images],
        timings=timings,
    )
    logger.info(
        "parse finished",
        extra={
            "pages": artifact.page_count,
            "elements": len(artifact.contents),
            "ocr_pages": len(recognized),
            "tables": sum(result.tables for result in recognized),
            "figures": len(images),
            "captioned": sum(1 for image in images if image.caption),
            "timings_ms": timings,
        },
    )
    return artifact


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


def _merge(
    parsed: DoclingParse,
    recognized: list[OcrPageResult],
) -> tuple[list[ParsedElement], str]:
    """Interleave the two tiers' elements into one reading order, and re-number them.

    A page belongs to exactly one tier, so ordering by page number is enough to
    interleave them and each page's own order survives a stable sort. The ids
    are then reassigned from zero: `element_id` is zero-padded precisely so that
    a lexical sort is a reading-order sort, and two independently-numbered runs
    concatenated would break that promise on every mixed document.
    """
    if not recognized:
        return parsed.contents, parsed.markdown

    combined: list[ParsedElement] = list(parsed.contents)
    for result in recognized:
        combined.extend(result.elements_for_artifact(first_index=0))
    combined.sort(key=lambda element: element.page)

    renumbered = [
        ParsedElement(
            id=element_id(index),
            type=element.type,
            text=element.text,
            markdown=element.markdown,
            page=element.page,
            bbox=element.bbox,
            section_path=element.section_path,
            level=element.level,
            table=element.table,
        )
        for index, element in enumerate(combined)
    ]

    # Composed rather than Docling's export: see `markdown_from_elements`. A
    # document with no native pages has no Docling markdown at all, and a mixed
    # one has markdown covering only half of itself.
    return renumbered, markdown_from_elements(renumbered)


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
    llm: bool,
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

    router = VisionRouter.configured(settings) if llm else None
    candidates = extract_images(
        path,
        geometries=geometries,
        skip_pages=skip_pages,
        min_edge=settings.figure_min_edge,
        limit=settings.figure_max_per_document,
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
            index = len(stored) + 1
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
) -> None:
    """Render and upload one thumbnail per page, in bounded batches.

    Rendered on a thread in batches and uploaded from the loop in between, so
    that neither the whole document's bitmaps nor the whole document's uploads
    are ever outstanding at once. A 500-page monster is the case this shape
    exists for.
    """
    by_page = {page.page_no: page for page in pages}
    renderer = render_thumbnails(path, max_edge=settings.worker_thumbnail_max_edge)
    batch_size = max(settings.worker_parse_threads, 1)

    while True:
        batch = await asyncio.to_thread(_take, renderer, batch_size)
        if not batch:
            return
        for page_no, image in batch:
            key = thumbnail_key(org_id, document_id, page_no)
            await store.put_bytes(key, image, content_type=THUMBNAIL_CONTENT_TYPE)
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
