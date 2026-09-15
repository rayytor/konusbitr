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
from typing import Any

from konusbitr_worker.ai import ChatRouter, EmbeddingRouter, Tokenizer
from konusbitr_worker.chunk import (
    ChunkingOptions,
    chunk_elements,
    elements_from_contents,
    figure_elements,
)
from konusbitr_worker.chunk.embed import EmbedReport, ProgressCallback, embed_and_store
from konusbitr_worker.contracts import STAGE_PERCENT, JobErrorCode, JobPayload, JobStage, JobType
from konusbitr_worker.db import Database, PageRow
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.ids import ID_PREFIXES, new_id
from konusbitr_worker.log import get_logger
from konusbitr_worker.parse import parse_document
from konusbitr_worker.parse.artifact import ParseArtifact
from konusbitr_worker.parse.storage import ObjectStore
from konusbitr_worker.progress import ProgressReporter
from konusbitr_worker.prompts import load_prompt
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
) -> JobOutcome:
    """Take a document from `queued` to `ready`, doing only what is not done."""
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

    async def announce(stage: JobStage) -> None:
        await progress.stage(stage, message=STAGE_MESSAGES.get(stage))

    cached = await database.parse_artifact(document.content_hash, document.settings_hash)

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
        artifact = await parse_document(
            store=store or ObjectStore.from_settings(settings),
            settings=settings,
            org_id=document.org_id,
            document_id=document.id,
            storage_key=document.storage_key,
            content_hash=document.content_hash,
            lang_list=list(payload.settings.langList),
            llm=payload.settings.llm,
            on_stage=announce,
        )
        await _persist_parse(
            artifact,
            payload=payload,
            database=database,
            document_id=document.id,
            content_hash=document.content_hash,
            settings_hash=document.settings_hash,
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

    await _summarize_and_embed(
        markdown,
        database=database,
        settings=settings,
        org_id=document.org_id,
        document_id=document.id,
    )

    return JobOutcome(page_count=page_count, reused=reused, embed=embed)


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
