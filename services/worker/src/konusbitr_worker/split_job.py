"""The `split` job: one document in, several documents out.

Separate from :mod:`konusbitr_worker.pipeline` on purpose. `run_job` is the
parse pipeline — fetch, tier, parse, chunk, embed — and its three job types are
the same walk with different short-circuits. A split is not that walk at all: it
creates rows, writes objects, and derives parses rather than producing one. Two
things that share only "a job arrives and a document is touched" should not
share a function.

What it does, in order, for each range:

1. Cut the pages out of the parent with pypdf, and hash the result.
2. Store the bytes under the new document's own prefix.
3. Insert the `documents` row — the first point at which the content hash is
   known, which is why the row cannot be created by the API beforehand.
4. Derive the output's parse artifact from the parent's, renumbering pages.
5. Chunk and embed it, so the output is answerable the moment it exists.

Every step is replay-safe. Delivery is at-least-once, the object write is an
overwrite, the row insert is `ON CONFLICT DO NOTHING` returning the existing
id, the parse upsert is keyed on the content hash, and the chunk write is an
upsert on `(document_id, ordinal)`. A re-delivered split produces the same
documents rather than a second set of them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from konusbitr_worker.ai import EmbeddingRouter
from konusbitr_worker.chunk import chunk_elements, elements_from_contents
from konusbitr_worker.chunk.embed import embed_and_store
from konusbitr_worker.contracts import JobErrorCode, JobPayload, JobStage
from konusbitr_worker.db import Database, PageRow
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.ids import ID_PREFIXES, new_id
from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.split import derive_artifact, slice_ranges
from konusbitr_worker.parse.storage import ObjectStore
from konusbitr_worker.progress import ProgressReporter
from konusbitr_worker.scratch import scratch_space
from konusbitr_worker.settings import Settings

__all__ = ["SplitOutcome", "run_split"]

logger = get_logger("konusbitr.worker.split_job")

#: What the objects are stored as. The intake path accepts only PDFs, and a
#: slice of a PDF is a PDF.
_PDF_MIME = "application/pdf"


@dataclass(slots=True)
class SplitOutcome:
    """What the job produced, as `jobs.result` records it for the API to read."""

    documents: list[dict[str, Any]]

    def result(self) -> dict[str, Any]:
        return {"documents": self.documents, "outputs": len(self.documents)}


def _original_key(org_id: str, document_id: str) -> str:
    """Where an output's bytes live.

    **This must agree with `originalKey` in `packages/storage/src/keys.ts`.**
    The same layout, built from generated ids and never from the caller's
    range names — a split output is named after a heading, and a heading is
    document text, which must never reach a storage path.
    """
    return f"orgs/{org_id}/documents/{document_id}/original.pdf"


async def run_split(
    payload: JobPayload,
    *,
    database: Database,
    progress: ProgressReporter,
    settings: Settings,
    store: ObjectStore | None = None,
) -> SplitOutcome:
    """Cut the parent into the ranges the payload names."""
    if payload.split is None or not payload.split.ranges:
        raise JobFailure(
            JobErrorCode.invalid_payload,
            "A split job must carry the ranges to cut.",
        )

    document = await database.document(payload.documentId, payload.orgId)
    if document is None:
        raise JobFailure(JobErrorCode.document_missing, "That document no longer exists.")

    if document.content_hash != payload.contentHash:
        raise JobFailure(
            JobErrorCode.content_hash_mismatch,
            "That job refers to a version of the document that is no longer stored.",
        )

    objects = store or ObjectStore.from_settings(settings)

    await progress.stage(JobStage.fetching, message="Fetching the document")

    parent = (
        await database.parse_artifact(document.content_hash, document.settings_hash)
        if payload.split.inheritParse
        else None
    )

    documents: list[dict[str, Any]] = []

    # The parent is downloaded into the same per-job scratch directory a long
    # parse spills its thumbnails to, so a split of a 500MB filing is bounded
    # by disk rather than by the worker's 2GB memory ceiling.
    with scratch_space(payload.jobId) as scratch:
        source = scratch.root / "original.pdf"
        await objects.download(document.storage_key, source)

        await progress.stage(JobStage.parsing, message="Cutting the document")
        slices = slice_ranges(source, list(payload.split.ranges))

        for index, sliced in enumerate(slices, start=1):
            child_id = new_id(ID_PREFIXES["document"])
            key = _original_key(document.org_id, child_id)

            # Bytes first, row second. An object with no row is reclaimable
            # rubbish; a row pointing at bytes that were never written is a
            # document that fails the moment somebody opens it.
            await objects.put_bytes(key, sliced.content, content_type=_PDF_MIME)

            stored_id = await database.create_split_document(
                document_id=child_id,
                org_id=document.org_id,
                filename=sliced.name,
                mime=_PDF_MIME,
                byte_size=len(sliced.content),
                page_count=sliced.page_count,
                storage_key=key,
                content_hash=sliced.content_hash,
                settings_hash=document.settings_hash,
                # `ready` when the parse is inherited, because it genuinely is:
                # the elements exist and the index is written below before the
                # job completes. Otherwise `queued`, and an operator or the
                # caller reparses it.
                status="ready" if parent is not None else "queued",
            )

            if stored_id is None:
                logger.warning("a split output could not be recorded", extra={"name": sliced.name})
                continue

            if stored_id != child_id:
                # A re-delivery, or two ranges that produced identical bytes —
                # the same pages asked for twice. The row that exists wins, and
                # the object just written is the same bytes under a different
                # key, so it is left to be swept with the document it belongs
                # to rather than deleted here mid-job.
                logger.info("a split output already existed", extra={"docId": stored_id})

            if parent is not None and isinstance(parent.contents, dict):
                await _persist_derived(
                    database=database,
                    settings=settings,
                    payload=payload,
                    org_id=document.org_id,
                    document_id=stored_id,
                    content_hash=sliced.content_hash,
                    settings_hash=document.settings_hash,
                    parent_contents=parent.contents,
                    parent_markdown=parent.markdown,
                    pages=sliced.pages,
                )

            documents.append({"docId": stored_id, "name": sliced.name, "pages": sliced.pages})

            await progress.stage(
                JobStage.persisting,
                message=f"Wrote {index} of {len(slices)}",
            )

    logger.info("split finished", extra={"outputs": len(documents)})
    return SplitOutcome(documents=documents)


async def _persist_derived(
    *,
    database: Database,
    settings: Settings,
    payload: JobPayload,
    org_id: str,
    document_id: str,
    content_hash: str,
    settings_hash: str,
    parent_contents: dict[str, Any],
    parent_markdown: str | None,
    pages: list[int],
) -> None:
    """Write an output's inherited parse and index it.

    The chunking is not optional and is not deferred. A document row that says
    `ready` with no chunks behind it is the failure this codebase has a
    load-bearing invariant against: chat would answer over it out of an empty
    index, confidently and with nothing to cite.
    """
    contents, markdown = derive_artifact(parent_contents, parent_markdown, pages)

    await database.upsert_parse_result(
        parse_result_id=new_id(ID_PREFIXES["parse_result"]),
        document_id=document_id,
        content_hash=content_hash,
        settings_hash=settings_hash,
        quality=payload.settings.quality.value,
        lang_list=list(payload.settings.langList),
        llm_enabled=payload.settings.llm,
        markdown=markdown,
        contents=contents,
        page_count=len(pages),
        # No checkpoint: this parse is complete the moment it is derived, so
        # the row is a docId cache entry and a second upload of these exact
        # bytes is free.
        checkpoint=None,
    )

    await database.upsert_pages(
        document_id=document_id,
        pages=[
            PageRow(
                id=new_id(ID_PREFIXES["page"]),
                page_no=int(row["pageNo"]),
                width=round(float(row.get("width") or 0)),
                height=round(float(row.get("height") or 0)),
                thumbnail_key=None,
                tier=str(row.get("tier") or "native"),
                ocr_confidence=_as_confidence(row.get("ocrConfidence")),
            )
            for row in contents["pages"]
            if isinstance(row, dict) and "pageNo" in row
        ],
    )

    if await database.chunk_count(document_id) > 0:
        # A re-delivery. The index is already there and rewriting it would be
        # work with no effect.
        return

    # Imported here rather than at module scope: both live in the pipeline,
    # which imports nothing from this module — but a top-level import in this
    # direction would still make the pair a cycle the moment it ever did.
    from konusbitr_worker.pipeline import _chunking_options, _fallback_tokenizer

    router = EmbeddingRouter.configured(settings)
    chunks = chunk_elements(
        elements_from_contents(contents),
        tokenizer=router.tokenizer if router is not None else _fallback_tokenizer(settings),
        options=_chunking_options(settings),
    )

    await embed_and_store(
        chunks,
        database=database,
        org_id=org_id,
        document_id=document_id,
        router=router,
    )


def _as_confidence(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
