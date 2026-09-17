"""The document pipeline: take a document from `queued` to `ready`.

This module is the orchestration and the **writes**; the parsing lives in
:mod:`konusbitr_worker.parse` and the chunking in
:mod:`konusbitr_worker.chunk`. The split is the point. Everything that has to
hold true regardless of which parser or which embedding model ran — the
org-scoped lookup, the content-hash check, the short-circuits, the
at-least-once-safe upserts — is here and is small enough to read in one
sitting.

The rule that governs every line below: **a re-delivered job must be a no-op.**
Redis promises at-least-once delivery, so "exactly once" is a property the
writes have to provide. Every statement this module issues is an upsert, and
each expensive stage short-circuits when the thing it was about to produce
already exists.

Three job types arrive here, and the difference between them is only which
short-circuits apply:

- `parse` — parse if there is no cached artifact, then chunk and embed if there
  are no chunks. The ordinary path.
- `chunk_embed` — take the cached artifact and chunk and embed it. Skips the
  parse; still skips the chunking if chunks exist.
- `reindex` — chunk and embed unconditionally. What an operator runs after
  changing the chunker or the embedding model, and the reason the docId cache
  is architecture rather than optimisation: re-indexing never re-parses.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from konusbitr_worker.ai import ChatRouter, EmbeddingRouter, Tokenizer
from konusbitr_worker.chunk import (
    ChunkingOptions,
    chunk_elements,
    elements_from_contents,
    figure_elements,
)
from konusbitr_worker.chunk.embed import EmbedReport, ProgressCallback, embed_and_store
from konusbitr_worker.contracts import (
    JOB_CHECKPOINT_VERSION,
    STAGE_PERCENT,
    JobErrorCode,
    JobPayload,
    JobStage,
    JobType,
)
from konusbitr_worker.db import Database, DocumentRecord, PageRow
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.ids import ID_PREFIXES, new_id
from konusbitr_worker.log import get_logger
from konusbitr_worker.parse import (
    BatchOutcome,
    CancelCheck,
    StageReporter,
    parse_document,
)
from konusbitr_worker.parse.artifact import ParseArtifact
from konusbitr_worker.parse.batching import ResumeState, resume_state_from
from konusbitr_worker.parse.storage import ObjectStore
from konusbitr_worker.progress import ProgressReporter
from konusbitr_worker.prompts import load_prompt
from konusbitr_worker.scratch import scratch_space
from konusbitr_worker.settings import Settings

__all__ = ["JobOutcome", "run_job"]

logger = get_logger("konusbitr.worker.pipeline")

#: What a person watching a spinner is told at each stage.
#:
#: Product copy, kept here rather than in the parser or the chunker: it is
#: addressed to whoever uploaded the file, it is rendered on a page, and it must
#: never contain a word of the document — the whole document is untrusted input.
STAGE_MESSAGES: dict[JobStage, str] = {
    JobStage.fetching: "Fetching the document",
    JobStage.validating: "Checking the file",
    JobStage.parsing: "Reading the layout",
    # Named for what it is rather than softened into "Reading the layout". A
    # scan takes noticeably longer than a born-digital document and a reader
    # watching a bar is owed the reason, not a spinner that appears to have
    # stalled.
    JobStage.ocr: "Recognising scanned pages",
    JobStage.chunking: "Splitting into passages",
    JobStage.embedding: "Building the index",
    JobStage.persisting: "Saving the result",
}


@dataclass(frozen=True, slots=True)
class JobOutcome:
    """What the runtime needs to know once a handler has finished."""

    page_count: int | None
    #: True when the expensive half had already been done and was skipped.
    reused: bool = False
    #: Chunking and embedding, when this job did any.
    embed: EmbedReport | None = None

    def result(self) -> dict[str, Any]:
        """The `jobs.result` payload an operator reads."""
        payload: dict[str, Any] = {"reused": self.reused, "pages": self.page_count}
        if self.embed is not None:
            payload |= self.embed.to_json()
        return payload


async def run_job(
    payload: JobPayload,
    *,
    database: Database,
    progress: ProgressReporter,
    settings: Settings,
    store: ObjectStore | None = None,
    cancelled: CancelCheck | None = None,
) -> JobOutcome:
    """Take a document from `queued` to `ready`, doing only what is not done.

    `cancelled` is asked between pages and between batches. It is a plain
    synchronous predicate rather than an event or a token because it is also
    consulted from inside the worker threads that do the recognition, where
    there is no event loop to await on.
    """
    document = await database.document(payload.documentId, payload.orgId)
    if document is None:
        # Terminal, not retryable: the row was deleted, or the payload named a
        # document belonging to somebody else. Neither improves with time.
        raise JobFailure(
            JobErrorCode.document_missing,
            "That document no longer exists.",
        )

    if document.content_hash != payload.contentHash:
        # A payload is a message, not an authority. If the two disagree the job
        # is stale — the document was replaced under it — and re-running it
        # would write one document's parse under another's hashes.
        raise JobFailure(
            JobErrorCode.content_hash_mismatch,
            "That job refers to a version of the document that is no longer stored.",
        )

    async def announce(stage: JobStage, message: str | None = None) -> None:
        # The parse may override the wording for a stage two tiers share — see
        # `StageReporter`. It never invents a *stage*, which is the part of this
        # that crosses the runtime boundary.
        await progress.stage(stage, message=message or STAGE_MESSAGES.get(stage))

    cached = await database.parse_artifact(document.content_hash, document.settings_hash)
    #: Chunks written by the batched parse, or `None` when this job did not run
    #: one — a cache hit, a reindex, or a chunk_embed. The distinction decides
    #: whether the index still has to be built after the parse or has already
    #: been built during it.
    indexed: int | None = None

    if payload.type is JobType.parse and cached is not None:
        # The docId cache hit. In Phase 07 this completed the job outright,
        # which was wrong the moment chunking existed: the parse being cached
        # says nothing about whether *this document* has been chunked, and a
        # second organization uploading the same bytes got a `ready` document
        # with an empty index. So the parse is skipped and the rest is not.
        logger.info("reusing a cached parse")
        artifact_contents = cached.contents
        page_count = cached.page_count or document.page_count
        reused = True
        await _upsert_cached_pages(
            database,
            document_id=document.id,
            artifact_contents=artifact_contents,
        )
    elif payload.type is JobType.parse:
        artifact, indexed = await _parse_in_batches(
            payload=payload,
            document=document,
            database=database,
            progress=progress,
            settings=settings,
            store=store or ObjectStore.from_settings(settings),
            announce=announce,
            cancelled=cancelled,
        )
        artifact_contents = artifact.to_json(include_markdown=False)
        page_count = artifact.page_count
        reused = False
    else:
        # `chunk_embed` and `reindex` never parse. That is the whole point of
        # them, and of the docId cache: the chunker or the embedding model can
        # change, and re-indexing a library costs embeddings rather than a
        # second pass over every PDF.
        if cached is None:
            raise JobFailure(
                JobErrorCode.document_missing,
                "That document has not been parsed yet, so there is nothing to index.",
            )
        artifact_contents = cached.contents
        page_count = cached.page_count or document.page_count
        reused = True
    markdown: str | None = cached.markdown if cached is not None else artifact.markdown

    if indexed is None:
        embed = await _chunk_and_embed(
            artifact_contents,
            payload=payload,
            database=database,
            progress=progress,
            settings=settings,
            org_id=document.org_id,
            document_id=document.id,
            force=payload.type is JobType.reindex,
        )
    else:
        # The batched parse indexed as it went, so there is nothing left to
        # chunk — only the two statements that are about the document as a
        # whole and therefore could not be made until it was whole.
        embed = await _finalize_index(
            database=database,
            settings=settings,
            document_id=document.id,
            progress=progress,
            total=indexed,
        )

    await _summarize_and_embed(
        markdown,
        database=database,
        settings=settings,
        org_id=document.org_id,
        document_id=document.id,
    )

    return JobOutcome(page_count=page_count, reused=reused, embed=embed)


async def _parse_in_batches(
    *,
    payload: JobPayload,
    document: DocumentRecord,
    database: Database,
    progress: ProgressReporter,
    settings: Settings,
    store: ObjectStore,
    announce: StageReporter,
    cancelled: CancelCheck | None,
) -> tuple[ParseArtifact, int]:
    """Parse a document, committing after every page batch.

    This is where Phase 12.4's three claims are actually made good, and each is
    one line of the callback below.

    **Resumable.** The incomplete `parse_results` row is read first; if it
    holds a checkpoint this build agrees with, the parse starts at the page
    after it and the pages before are never opened again.

    **Durable.** After every batch the artifact so far, its page rows, its
    chunks and its checkpoint are written. Each of those writes is an upsert
    keyed on something stable, so a batch redelivered after a crash overwrites
    rather than doubles — the at-least-once rule, applied at a finer grain than
    Phase 06 needed it.

    **Answerable early.** The chunks of a batch are embedded as part of that
    batch, so after the first one the document really can be searched. That is
    what lets the status become `partially_ready` honestly: a chunk exists only
    because the page it came from was read, so an answer over a partially-ready
    document cites pages that have genuinely been parsed.

    The one thing to keep in mind when changing this: **the callback must
    return the running chunk total.** Ordinals have to stay contiguous across
    batches and across a resume, because `upsert_chunks` keys on
    `(document_id, ordinal)` and the final prune deletes everything past the
    count — a batch that restarted its numbering would overwrite its
    predecessor's rows and then delete the document's tail.
    """
    resume = await _resume_state(database, document, settings)
    batch_size = max(settings.worker_page_batch_size, 1)
    router = EmbeddingRouter.configured(settings)
    tokenizer = router.tokenizer if router is not None else _fallback_tokenizer(settings)
    batches = 0
    indexed = resume.chunks_written if resume is not None and resume.is_useful else 0

    async def commit(outcome: BatchOutcome) -> int:
        nonlocal batches, indexed
        batches += 1
        final = outcome.pages_done >= outcome.page_count
        # Named stages, but only for a document read in one pass — which is
        # almost every upload. In a batched ingest the stages *interleave*:
        # page 17 is being recognised while pages 1 to 16 are being embedded,
        # so announcing `embedding` at the first batch would pin the bar at 85%
        # for the remaining fourteen minutes and announcing it per batch would
        # flip the label fifty-six times. There, `progress.pages` carries the
        # report instead, spread across the same span.
        single = outcome.page_count <= batch_size
        # Held before anything is announced, so every frame this batch produces
        # carries them — including the stage frames below.
        progress.note_pages(ready=outcome.pages_done, total=outcome.page_count)
        if single and batches == 1:
            await progress.stage(JobStage.chunking, message=STAGE_MESSAGES[JobStage.chunking])
            await progress.stage(JobStage.embedding, message=STAGE_MESSAGES[JobStage.embedding])

        written = await _embed_batch(
            outcome,
            database=database,
            org_id=document.org_id,
            document_id=document.id,
            router=router,
            tokenizer=tokenizer,
            settings=settings,
            first_ordinal=outcome.chunks_written,
            # Only for a document read in one pass. There, `embedding` is a
            # real stage with a beginning and an end and the bar can move
            # through its band as chunks land. In a batched ingest the band
            # would be traversed once per batch, which is a bar that resets
            # fifty-six times — `progress.pages` reports that case instead.
            on_progress=_embedding_progress(progress) if single else None,
        )

        # **The checkpoint is written after the work it describes, never
        # before.** It was the other way round once, and the bug it caused is
        # the exact bug checkpointing exists to prevent: the row recorded
        # "pages 1-8 done, 2 chunks written" while four chunks were in the
        # table, so the resumed run began numbering at 2, overwrote the chunks
        # for pages 5-8, and then pruned the document's tail — a document that
        # looked fully indexed and answered out of two thirds of itself.
        #
        # Crashing in the gap between the two is harmless and is the case this
        # order is chosen for: the chunks for the batch exist at ordinals the
        # resume will write again, every write is an upsert, and the pages are
        # simply read once more.
        checkpoint = (
            None
            if final
            else {
                "version": JOB_CHECKPOINT_VERSION,
                "lastProcessedPage": outcome.pages_done,
                "totalPages": outcome.page_count,
                "batchSize": batch_size,
                "chunksWritten": written,
                "updatedAt": datetime.now(UTC).isoformat(),
            }
        )

        await _persist_parse(
            outcome.artifact,
            payload=payload,
            database=database,
            document_id=document.id,
            content_hash=document.content_hash,
            settings_hash=document.settings_hash,
            # NULL on the last batch and only then. A row carrying a checkpoint
            # is by definition an ingest in progress and is filtered out of
            # every docId cache lookup in both runtimes, so this is the
            # statement that turns a partial parse into a cache entry.
            checkpoint=checkpoint,
        )
        # Mirrored for whoever reads the job table. Nothing branches on this
        # copy — the resume reads the one on `parse_results`, which is written
        # in the same breath as the partial parse it describes.
        await database.record_checkpoint(job_id=payload.jobId, checkpoint=checkpoint)

        await database.set_page_counts(
            document_id=document.id,
            ready=outcome.pages_done,
            total=outcome.page_count,
        )
        # Announced only while there is more to come. On the last batch the job
        # is about to report `ready`, and telling a reader their document is
        # partly available a moment before telling them it is finished is a
        # flicker rather than information.
        if not final:
            await database.mark_partially_ready(document_id=document.id)
        if not single:
            await progress.pages(
                ready=outcome.pages_done,
                total=outcome.page_count,
                message=_batch_message(outcome),
            )

        logger.info(
            "batch committed",
            extra={
                "pages": f"{outcome.first_page}-{outcome.last_page}",
                "of": outcome.page_count,
                "chunks": written,
                "final": final,
            },
        )
        indexed = written
        return written

    with scratch_space(payload.jobId) as scratch:
        artifact = await parse_document(
            store=store,
            settings=settings,
            org_id=document.org_id,
            document_id=document.id,
            storage_key=document.storage_key,
            content_hash=document.content_hash,
            lang_list=list(payload.settings.langList),
            llm=payload.settings.llm,
            # Phase 12.3's tier selector. It is part of `settings_hash`, so an
            # advanced parse and a standard one of the same bytes are two cache
            # entries — and therefore two checkpoint lineages, which is why a
            # retry at a different quality reads the whole document again.
            quality=payload.settings.quality.value,
            on_stage=announce,
            batch_size=batch_size,
            resume=resume,
            on_batch=commit,
            should_cancel=cancelled,
            scratch=scratch,
        )

    logger.info(
        "parse committed",
        extra={"batches": batches, "pages": artifact.page_count, "chunks": indexed},
    )
    return artifact, indexed


async def _resume_state(
    database: Database,
    document: DocumentRecord,
    settings: Settings,
) -> ResumeState | None:
    """What an interrupted run of this job already committed, if anything.

    Read from the database rather than from the queue message, because a stream
    entry is redelivered exactly as it was written — it cannot know what
    happened after it was read. The incomplete `parse_results` row is the only
    thing that saw the work.
    """
    found = await database.resume_point(document.content_hash, document.settings_hash)
    if found is None:
        return None
    row, checkpoint = found
    return resume_state_from(
        checkpoint,
        row.contents,
        markdown=row.markdown,
        batch_size=max(settings.worker_page_batch_size, 1),
    )


async def _embed_batch(
    outcome: BatchOutcome,
    *,
    database: Database,
    org_id: str,
    document_id: str,
    router: EmbeddingRouter | None,
    tokenizer: Tokenizer,
    settings: Settings,
    first_ordinal: int,
    on_progress: ProgressCallback | None = None,
) -> int:
    """Chunk and embed one batch's elements, continuing the document's ordinals.

    Deliberately does **not** prune. Pruning is "delete everything past the
    final count", and there is no final count until the last batch — a prune
    after batch one would delete every chunk a resumed job had already written
    for the batches after it. The prune happens once, in `_chunk_and_embed`,
    when the document is whole.

    Figures are read out of this batch's own elements only. A figure chunk
    carries the figure's rectangle, so it belongs to the batch whose pages the
    figure is on, and re-deriving them from the accumulated artifact each batch
    would write the same figure chunk once per remaining batch.
    """
    chunks = chunk_elements(
        elements_from_contents({"contents": [element.to_json() for element in outcome.elements]}),
        tokenizer=tokenizer,
        options=_chunking_options(settings),
        figures=figure_elements(
            {
                "images": [
                    image
                    for image in outcome.artifact.images
                    if outcome.first_page <= int(image.get("page") or 0) <= outcome.last_page
                ]
            }
        ),
        first_ordinal=first_ordinal,
    )
    if not chunks:
        return first_ordinal

    report = await embed_and_store(
        chunks,
        database=database,
        org_id=org_id,
        document_id=document_id,
        router=router,
        finalize=False,
        counts_from=first_ordinal,
        on_progress=on_progress,
    )
    return first_ordinal + report.total


async def _finalize_index(
    *,
    database: Database,
    settings: Settings,
    document_id: str,
    progress: ProgressReporter,
    total: int,
) -> EmbedReport:
    """The two index statements that can only be made once the document is whole.

    **The prune.** `embed_and_store` deletes every chunk past the count it just
    wrote, which is the right rule for a document chunked in one pass and the
    wrong one for a document chunked in fifty-six: after batch one there is no
    "past the end" yet. So the batches do not prune and this does, once, with
    the real count. It is what makes a re-parse that produces four hundred
    chunks where there were five hundred leave four hundred rows rather than
    four hundred fresh ones and a hundred stale ones with stale vectors that
    retrieval would happily return.

    **The embedding model.** Which model produced a document's vectors is a
    property of the index rather than of a batch, and recording it before the
    last batch would claim a document was fully embedded by a model that had
    only seen the first sixteen pages of it.
    """
    await database.prune_chunks(document_id=document_id, keep=total)
    router = EmbeddingRouter.configured(settings)
    if router is not None:
        await database.set_document_embedding(
            document_id=document_id, model=router.model_name, dims=router.dimensions
        )
    await progress.stage(JobStage.persisting, message=STAGE_MESSAGES[JobStage.persisting])
    return EmbedReport(
        total=total,
        embedded=total if router is not None else 0,
        model=router.model_name if router is not None else None,
        dims=router.dimensions if router is not None else None,
    )


def _batch_message(outcome: BatchOutcome) -> str:
    """What a person watching a long ingest is told after a batch.

    Pages rather than a percentage, because a reader knows how long their
    document is: "142 of 900 pages read" is something they can estimate from,
    and 23% is not. Never contains a word of the document.
    """
    if outcome.pages_done >= outcome.page_count:
        return "Saving the result"
    return f"Read {outcome.pages_done} of {outcome.page_count} pages"


async def _chunk_and_embed(
    contents: dict[str, Any] | None,
    *,
    payload: JobPayload,
    database: Database,
    progress: ProgressReporter,
    settings: Settings,
    org_id: str,
    document_id: str,
    force: bool,
) -> EmbedReport | None:
    """Chunk the artifact and embed the chunks, unless that is already done.

    Returns `None` when nothing was done, so that the caller can report a job
    that genuinely did no work — which is what a re-delivery after a completed
    embed looks like, and what must not walk a watching browser back through
    "Indexing".
    """
    if not force and await database.chunk_count(document_id) > 0:
        logger.info("chunks already exist; skipping the index")
        return None

    await progress.stage(JobStage.chunking, message=STAGE_MESSAGES[JobStage.chunking])

    # Built before the chunker runs, because it is what knows the tokenizer:
    # the band is measured in the configured embedding model's tokens, and a
    # character count would be out by a factor of four in English and out
    # differently in Turkish.
    router = EmbeddingRouter.configured(settings)
    chunks = chunk_elements(
        elements_from_contents(contents),
        tokenizer=router.tokenizer if router is not None else _fallback_tokenizer(settings),
        options=_chunking_options(settings),
        # Read out of the artifact's `images` rather than its `contents`, which
        # is why a `reindex` recreates the figure chunks without re-extracting
        # or re-captioning anything: the captions are in the cached parse.
        figures=figure_elements(contents),
    )

    await progress.stage(JobStage.embedding, message=STAGE_MESSAGES[JobStage.embedding])

    report = await embed_and_store(
        chunks,
        database=database,
        org_id=org_id,
        document_id=document_id,
        router=router,
        on_progress=_embedding_progress(progress),
    )

    await progress.stage(JobStage.persisting, message=STAGE_MESSAGES[JobStage.persisting])
    logger.info("index written", extra={"job_type": payload.type.value, **report.to_json()})
    return report


def _embedding_progress(progress: ProgressReporter) -> ProgressCallback:
    """Move the bar between `embedding` and `persisting` as chunks land.

    The Phase 06 SSE stream is meant to show a bar rather than a spinner, and
    "85% for ninety seconds" is a spinner with extra steps. The span is the gap
    between the two stages in `STAGE_PERCENT`, so the number stays consistent
    with what a browser replaying from the `jobs` row computes.
    """
    floor = STAGE_PERCENT[JobStage.embedding]
    ceiling = STAGE_PERCENT[JobStage.persisting]

    async def report(written: int, total: int) -> None:
        if total <= 0:
            return
        # Capped one below `persisting`: the last batch landing is not the same
        # event as the document being saved, and a bar that reaches 95% twice
        # tells a watcher nothing the first time.
        percent = min(floor + round((ceiling - floor) * written / total), ceiling - 1)
        await progress.stage(
            JobStage.embedding,
            message=f"Building the index ({written} of {total})",
            percent=percent,
        )

    return report


def _chunking_options(settings: Settings) -> ChunkingOptions:
    return ChunkingOptions(
        target_tokens=settings.chunk_target_tokens,
        min_tokens=settings.chunk_min_tokens,
        max_tokens=settings.chunk_max_tokens,
        overlap_ratio=settings.chunk_overlap_ratio,
    )


def _fallback_tokenizer(settings: Settings) -> Tokenizer:
    """A tokenizer for a deployment with no embedding model configured.

    The chunks are still written, so they still need a size, and the size still
    has to be *a* consistent unit. `EMBEDDING_MODEL` unset means there is no
    model to ask, so the count is an estimate — and the chunks are re-made from
    the cached parse by the reindex that follows configuring one, at which point
    the real tokenizer decides the boundaries.
    """
    return Tokenizer(settings.model_for("embedding"))


async def _persist_parse(
    artifact: ParseArtifact,
    *,
    payload: JobPayload,
    database: Database,
    document_id: str,
    content_hash: str,
    settings_hash: str,
    checkpoint: dict[str, Any] | None = None,
) -> None:
    """Write the parse into the docId cache and the page geometry beside it.

    Both statements are replay-safe on their own, so the absence of a
    transaction spanning them is deliberate rather than an oversight: a job
    interrupted between the two is redelivered and writes both again, and the
    second write of each is a no-op.
    """
    await database.upsert_parse_result(
        parse_result_id=new_id(ID_PREFIXES["parse_result"]),
        document_id=document_id,
        content_hash=content_hash,
        settings_hash=settings_hash,
        quality=payload.settings.quality.value,
        lang_list=list(payload.settings.langList),
        llm_enabled=payload.settings.llm,
        markdown=artifact.markdown,
        contents=artifact.to_json(include_markdown=False),
        page_count=artifact.page_count,
        # `None` only on the final batch. A row carrying a checkpoint is an
        # ingest in progress and is filtered out of every docId cache lookup in
        # both runtimes, so this argument is what decides whether the row is
        # yet a cache entry at all.
        checkpoint=checkpoint,
    )

    await database.upsert_pages(
        document_id=document_id,
        pages=[
            PageRow(
                id=new_id(ID_PREFIXES["page"]),
                page_no=page.page_no,
                # The `pages` columns are integers, and a page dimension in
                # points is a whole number on every real document. Rounded
                # rather than truncated so a 595.276pt A4 width stores as 595
                # and not 595 by luck.
                width=round(page.width),
                height=round(page.height),
                thumbnail_key=page.thumbnail_key,
                tier=page.tier.value,
                ocr_confidence=page.ocr_confidence,
            )
            for page in artifact.pages
        ],
    )


async def _upsert_cached_pages(
    database: Database,
    *,
    document_id: str,
    artifact_contents: dict[str, Any] | list[Any],
) -> None:
    if not isinstance(artifact_contents, dict):
        return
    pages_data = artifact_contents.get("pages")
    if not isinstance(pages_data, list) or not pages_data:
        return
    await database.upsert_pages(
        document_id=document_id,
        pages=[
            PageRow(
                id=new_id(ID_PREFIXES["page"]),
                page_no=p.get("pageNo", p.get("page_no")),
                width=round(p.get("width", 0)),
                height=round(p.get("height", 0)),
                thumbnail_key=p.get("thumbnailKey", p.get("thumbnail_key")),
                # Defaulted, not assumed. An artifact cached before Phase 12.1
                # carries no tier at all, and the parse it records was a
                # standard-tier one by construction — the OCR tier did not
                # exist when it ran.
                tier=str(p.get("tier") or "native"),
                ocr_confidence=_as_confidence(p.get("ocrConfidence")),
            )
            for p in pages_data
            if isinstance(p, dict) and ("pageNo" in p or "page_no" in p)
        ],
    )


def _as_confidence(value: Any) -> float | None:
    """A cached artifact's `ocrConfidence`, or `None` for anything unreadable."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


async def _summarize_and_embed(
    markdown: str | None,
    *,
    database: Database,
    settings: Settings,
    org_id: str,
    document_id: str,
) -> None:
    """Write a ~200-token abstract of the document and embed it.

    This is what two-stage corpus retrieval searches first. Past
    ``CORPUS_TWO_STAGE_THRESHOLD`` documents it is the *only* thing the first
    stage consults, so a summary that is really the document's opening words
    finds documents by their cover page and their table of contents rather than
    by what they are about — which is precisely the failure two-stage retrieval
    is supposed to avoid on a large corpus.

    So the summary is generated by the chat model through the router, using the
    versioned ``chat.summarize.v1`` prompt. When no chat model is configured —
    the default ``.env`` — it falls back to a lead extract and says so in the
    log. That is the same shape as an unconfigured embedding model: a reduced
    capability, not a failed job, and ``reindex`` regenerates it once a model is
    named.
    """
    if not markdown:
        return

    summary_text = await _summary_text(markdown, settings=settings, document_id=document_id)
    if not summary_text:
        return

    await database.upsert_document_summary(document_id=document_id, summary=summary_text)

    router = EmbeddingRouter.configured(settings)
    if router is None:
        return

    try:
        vectors = await router.embed([summary_text])
    except Exception:
        # A summary that cannot be embedded costs two-stage retrieval its first
        # stage for this one document, which falls back to searching every
        # document's chunks. Not worth failing a parse that otherwise succeeded.
        logger.warning("could not embed document summary", exc_info=True)
        return

    if vectors:
        await database.upsert_document_embedding(
            embedding_id=new_id(ID_PREFIXES["document_embedding"]),
            document_id=document_id,
            org_id=org_id,
            embedding=vectors[0],
        )


async def _summary_text(markdown: str, *, settings: Settings, document_id: str) -> str:
    """The abstract, generated if a chat model is configured and extracted if not."""
    router = ChatRouter.configured(settings)
    if router is not None:
        try:
            generated = await router.complete(
                system=load_prompt("chat.summarize.v1"),
                # Bounded rather than whole: a 500-page document does not fit a
                # context window, and the opening and closing of a document carry
                # most of what an abstract needs.
                user=_summarization_excerpt(markdown),
                max_tokens=SUMMARY_MAX_TOKENS,
            )
        except Exception:
            logger.warning(
                "could not generate a document summary; falling back to an extract",
                extra={"document_id": document_id},
                exc_info=True,
            )
        else:
            if generated:
                return generated

    return _lead_extract(markdown)


#: Roughly the ~200-token abstract the phase asks for, with room for a sentence
#: the model would otherwise be cut off mid-way through.
SUMMARY_MAX_TOKENS = 320

#: How much of a document is shown to the summarizer, in characters.
SUMMARY_EXCERPT_HEAD = 6000
SUMMARY_EXCERPT_TAIL = 2000


def _summarization_excerpt(markdown: str) -> str:
    """The opening and the closing of a document, which is what an abstract needs."""
    if len(markdown) <= SUMMARY_EXCERPT_HEAD + SUMMARY_EXCERPT_TAIL:
        return markdown
    head = markdown[:SUMMARY_EXCERPT_HEAD]
    tail = markdown[-SUMMARY_EXCERPT_TAIL:]
    return f"{head}\n\n[…]\n\n{tail}"


def _lead_extract(markdown: str, words: int = 200) -> str:
    """The fallback when no chat model is configured: the document's lead.

    Headings are dropped rather than kept, because a run of them is a table of
    contents and a table of contents is the least distinguishing text in a
    document.
    """
    body = [
        line.strip()
        for line in markdown.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    text = " ".join(body) or markdown
    return " ".join(text.split()[:words])
