"""The document pipeline: take a document from `queued` to `ready`.

This module is the orchestration and the **writes**; the parsing itself lives
in :mod:`konusbitr_worker.parse`. The split is the point. Everything that has
to hold true regardless of which parser ran — the org-scoped lookup, the
content-hash check, the short-circuit on an already-parsed document, the
at-least-once-safe upserts — is here and is small enough to read in one sitting.
Phase 12 adds a second parser tier without touching any of it.

The rule that governs every line below: **a re-delivered job must be a no-op.**
Redis promises at-least-once delivery, so "exactly once" is a property the
writes have to provide. Every statement this module issues is an upsert, and
the parse short-circuits before doing any work at all when the result it was
about to produce already exists.
"""

from __future__ import annotations

from dataclasses import dataclass

from konusbitr_worker.contracts import JobErrorCode, JobPayload, JobStage
from konusbitr_worker.db import Database, PageRow
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.ids import ID_PREFIXES, new_id
from konusbitr_worker.log import get_logger
from konusbitr_worker.parse import parse_document
from konusbitr_worker.parse.artifact import ParseArtifact
from konusbitr_worker.parse.storage import ObjectStore
from konusbitr_worker.progress import ProgressReporter
from konusbitr_worker.settings import Settings

__all__ = ["JobOutcome", "run_parse"]

logger = get_logger("konusbitr.worker.pipeline")

#: What a person watching a spinner is told at each stage.
#:
#: Product copy, kept here rather than in the parser: it is addressed to
#: whoever uploaded the file, it is rendered on a page, and it must never
#: contain a word of the document — the whole document is untrusted input.
STAGE_MESSAGES: dict[JobStage, str] = {
    JobStage.fetching: "Fetching the document",
    JobStage.validating: "Checking the file",
    JobStage.parsing: "Reading the layout",
    JobStage.persisting: "Saving the result",
}


@dataclass(frozen=True, slots=True)
class JobOutcome:
    """What the runtime needs to know once a handler has finished."""

    page_count: int | None
    #: True when the work had already been done and this delivery did nothing.
    reused: bool = False


async def run_parse(
    payload: JobPayload,
    *,
    database: Database,
    progress: ProgressReporter,
    settings: Settings,
    store: ObjectStore | None = None,
) -> JobOutcome:
    """Take a document from `queued` to `ready`."""
    document = await database.document(payload.documentId, payload.orgId)
    if document is None:
        # Terminal, not retryable: the row was deleted, or the payload named a
        # document belonging to somebody else. Neither improves with time.
        raise JobFailure(
            JobErrorCode.document_missing,
            "That document no longer exists.",
        )

    if document.content_hash != payload.contentHash:
        # A payload is a message, not an authority. If the two disagree, the
        # job is stale — the document was replaced under it — and re-running it
        # would write one document's parse under another's hashes.
        raise JobFailure(
            JobErrorCode.content_hash_mismatch,
            "That job refers to a version of the document that is no longer stored.",
        )

    # The idempotency short-circuit. A job re-delivered after a crash — or a
    # second job for bytes some other document already parsed — must not repeat
    # the work, and must still leave this document `ready`.
    if await database.parse_result_exists(document.content_hash, document.settings_hash):
        # No stage report on this path. The caller announces `ready` in a
        # moment, and reporting an intermediate stage for a document that is
        # already finished would push a watching browser backwards — from
        # "Ready" to "Indexing" and back — over work that did not happen.
        logger.info("parse already exists; completing without re-running")
        return JobOutcome(page_count=document.page_count, reused=True)

    async def announce(stage: JobStage) -> None:
        await progress.stage(stage, message=STAGE_MESSAGES.get(stage))

    artifact = await parse_document(
        store=store or ObjectStore.from_settings(settings),
        settings=settings,
        org_id=document.org_id,
        document_id=document.id,
        storage_key=document.storage_key,
        content_hash=document.content_hash,
        on_stage=announce,
    )

    await _persist(
        artifact,
        payload=payload,
        database=database,
        document_id=document.id,
        content_hash=document.content_hash,
        settings_hash=document.settings_hash,
    )

    return JobOutcome(page_count=artifact.page_count)


async def _persist(
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
            )
            for page in artifact.pages
        ],
    )
