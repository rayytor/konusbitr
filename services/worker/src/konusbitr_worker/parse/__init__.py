"""Parse pipeline v1: a text PDF in, markdown plus located elements out.

The stages, in order, each of which is a module of its own:

1. **fetch** — pull the object out of storage and re-derive its SHA-256. The
   payload said what the bytes should hash to; a payload is a message, not an
   authority, so the bytes are checked rather than believed.
2. **inspect** — open with PDFium: readable, not encrypted, within the page
   ceiling, and carrying a text layer worth parsing. Cheap structural questions,
   asked before a layout model is loaded.
3. **convert** — Docling, then normalization into the artifact. Everything
   parser-shaped stops at that module's edge.
4. **thumbnails** — one WebP per page, streamed to storage.

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
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

from konusbitr_worker.contracts import JobErrorCode, JobStage
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.artifact import ParseArtifact, ParsedPage
from konusbitr_worker.parse.docling_parser import convert
from konusbitr_worker.parse.inspect import inspect_pdf
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
    on_stage: StageReporter | None = None,
) -> ParseArtifact:
    """Run the whole parse and return the artifact. Writes thumbnails; writes no rows.

    Persistence is the caller's, deliberately. This function is a pure-ish
    function of the bytes it fetches, which is what lets the fixture tests run
    it end to end without a database — and what keeps the idempotency rules,
    which are about *writes*, in the one place that does any.
    """
    timings: dict[str, int] = {}

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
            )

        geometries = {page.page_no: page for page in inspection.pages}

        with _timed(timings, "convert"):
            await _announce(on_stage, JobStage.parsing)
            parsed = await asyncio.to_thread(
                convert,
                path,
                geometries=geometries,
                threads=settings.worker_parse_threads,
            )

        pages = [
            ParsedPage(
                page_no=geometry.page_no,
                width=geometry.width,
                height=geometry.height,
                rotation=geometry.rotation,
            )
            for geometry in inspection.pages
        ]

        with _timed(timings, "thumbnails"):
            await _announce(on_stage, JobStage.persisting)
            await _write_thumbnails(
                path,
                store=store,
                settings=settings,
                org_id=org_id,
                document_id=document_id,
                pages=pages,
            )

    artifact = ParseArtifact(
        markdown=parsed.markdown,
        page_count=inspection.page_count,
        contents=parsed.contents,
        pages=pages,
        timings=timings,
    )
    logger.info(
        "parse finished",
        extra={
            "pages": artifact.page_count,
            "elements": len(artifact.contents),
            "timings_ms": timings,
        },
    )
    return artifact


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
