"""The document pipeline. **A stub, deliberately, until Phase 07.**

Phase 06 exists to prove the seam, not the parser: that a job enqueued by
TypeScript reaches Python, walks the stage ladder, reports progress a browser
can watch, survives the worker being killed, and leaves the database in the
state a real parse would. So this handler sleeps where Docling will work, and
writes a `parse_results` row whose markdown says, in as many words, that it is
a placeholder.

Everything *around* the sleep is real and Phase 07 keeps it: the org-scoped
document lookup, the content-hash check, the short-circuit on an already-parsed
document, the page geometry write, the stage reporting. Phase 07 replaces the
body of :func:`run_parse` and touches nothing else.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from konusbitr_worker.contracts import JobErrorCode, JobPayload, JobStage
from konusbitr_worker.db import Database
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.ids import ID_PREFIXES, new_id
from konusbitr_worker.log import get_logger
from konusbitr_worker.progress import ProgressReporter
from konusbitr_worker.settings import Settings

__all__ = ["JobOutcome", "run_parse"]

logger = get_logger("konusbitr.worker.pipeline")

#: US Letter at 72dpi, in the one coordinate convention: PDF points, origin
#: top-left, y increasing downward, unrotated page. A real parser reports the
#: page's own box; the stub has no document to ask, and a plausible size keeps
#: the viewer's scale factor sane when Phase 11 renders one of these.
STUB_PAGE_WIDTH = 612
STUB_PAGE_HEIGHT = 792

#: The stages the stub walks, and what it says while it is there.
STUB_STAGES: tuple[tuple[JobStage, str], ...] = (
    (JobStage.fetching, "Fetching the document"),
    (JobStage.validating, "Checking the file"),
    (JobStage.parsing, "Reading the layout"),
    (JobStage.ocr, "Recognising text"),
    (JobStage.chunking, "Splitting into passages"),
    (JobStage.embedding, "Indexing for search"),
    (JobStage.persisting, "Saving the result"),
)


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

    for stage, message in STUB_STAGES:
        await progress.stage(stage, message=message)
        await asyncio.sleep(settings.worker_stub_stage_seconds)

    page_count = document.page_count or 1

    await database.upsert_parse_result(
        parse_result_id=new_id(ID_PREFIXES["parse_result"]),
        document_id=document.id,
        content_hash=document.content_hash,
        settings_hash=document.settings_hash,
        quality=payload.settings.quality.value,
        lang_list=list(payload.settings.langList),
        llm_enabled=payload.settings.llm,
        markdown=_placeholder_markdown(page_count),
        contents={"stub": True, "pages": page_count, "phase": 6},
        page_count=page_count,
    )

    await database.upsert_pages(
        document_id=document.id,
        pages=[
            (new_id(ID_PREFIXES["page"]), page_no, STUB_PAGE_WIDTH, STUB_PAGE_HEIGHT)
            for page_no in range(1, page_count + 1)
        ],
    )

    return JobOutcome(page_count=page_count)


def _placeholder_markdown(page_count: int) -> str:
    """Text that cannot be mistaken for a parse.

    Written to be obvious in a UI rather than plausible: a lorem-ipsum
    placeholder that looked like real content would make an unfinished
    pipeline indistinguishable from a finished one.
    """
    pages = "\n\n".join(
        f"## Page {page_no}\n\n"
        "_Placeholder — the Phase 06 stub pipeline produced this. "
        "Phase 07 replaces it with the Docling parse._"
        for page_no in range(1, page_count + 1)
    )
    return f"# Parse placeholder\n\n{pages}\n"
