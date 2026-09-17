"""Test doubles and fixtures for the two things the worker talks to.

The worker's dependencies are a Redis stream and a Postgres database, and both
are exercised for real by the cross-runtime integration test in
``apps/web/test/integration/worker.integration.test.ts`` — which enqueues from
TypeScript, starts this worker, and asserts against a real database. That is
the right place to prove the wiring.

What is left for pytest is the *logic*: does a terminal failure skip its
retries, does a re-delivery do nothing, does a malformed payload go straight to
the dead-letter list. Those are questions about branches, and answering them
against containers would trade seconds of CI for no extra confidence — so they
run against the doubles below, which record what was asked of them.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from konusbitr_worker.contracts import JobErrorCode, JobPayload, JobProgress, JobStage
from konusbitr_worker.db import ChunkRow, DocumentRecord, PageRow, ParseArtifactRow
from konusbitr_worker.errors import JobFailure


def sha256_of(path: Path) -> str:
    """The digest the pipeline will re-derive, so a test document can declare it."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


CONTENT_HASH = "a" * 64

BASE_ENV = {
    "app_url": "http://localhost:3000",
    "database_url": "postgresql://konusbitr:konusbitr@localhost:5432/konusbitr",
    "redis_url": "redis://localhost:6379",
    "s3_endpoint": "http://localhost:9000",
    "s3_bucket": "konusbitr",
    "s3_access_key_id": "konusbitr",
    "s3_secret_access_key": "konusbitr-dev-secret",
}


def make_payload(**overrides: Any) -> JobPayload:
    """A valid job payload, shaped exactly as the TypeScript side writes one."""
    fields: dict[str, Any] = {
        "v": 1,
        "jobId": "job_test",
        "type": "parse",
        "orgId": "org_test",
        "documentId": "doc_test",
        "storageKey": "orgs/org_test/documents/doc_test/original.pdf",
        "contentHash": CONTENT_HASH,
        "settings": {"quality": "standard", "langList": [], "llm": False},
        "attempt": 1,
        "enqueuedAt": "2026-01-01T00:00:00Z",
    }
    fields.update(overrides)
    return JobPayload.model_validate(fields)


def make_document(**overrides: Any) -> DocumentRecord:
    fields: dict[str, Any] = {
        "id": "doc_test",
        "org_id": "org_test",
        "filename": "report.pdf",
        "mime": "application/pdf",
        "byte_size": 1024,
        "page_count": 2,
        "storage_key": "orgs/org_test/documents/doc_test/original.pdf",
        "content_hash": CONTENT_HASH,
        "settings_hash": "b" * 64,
        "status": "queued",
    }
    fields.update(overrides)
    return DocumentRecord(**fields)


class FakeDatabase:
    """Records every write, and answers reads from what it has been given."""

    def __init__(self, document: DocumentRecord | None = None) -> None:
        self._document = document
        self.parse_results: list[dict[str, Any]] = []
        self.pages: list[PageRow] = []
        self.chunks: list[ChunkRow] = []
        self.stages: list[tuple[JobStage, int]] = []
        self.started: list[tuple[str, int]] = []
        self.completed: list[dict[str, Any]] = []
        self.failures: list[dict[str, Any]] = []
        self.chunk_counts: list[tuple[int, int]] = []
        self.embedding_recorded: list[tuple[str | None, int | None]] = []
        self.summaries: dict[str, str | None] = {}
        self.document_embeddings: dict[str, list[float]] = {}
        #: What `chunks.embedding` is declared as. `None` stands in for an
        #: untyped column, which the schema forbids but a hand-altered database
        #: could still present.
        self.declared_dimensions: int | None = 1024
        self.page_counts: list[tuple[int, int | None]] = []
        self.partially_ready: list[str] = []
        self.cancellations: list[dict[str, Any]] = []
        self.job_checkpoints: list[tuple[str, dict[str, Any] | None]] = []

    async def document(self, document_id: str, org_id: str) -> DocumentRecord | None:
        if self._document is None:
            return None
        if self._document.id != document_id or self._document.org_id != org_id:
            return None
        return self._document

    async def parse_result_exists(self, content_hash: str, settings_hash: str) -> bool:
        return any(
            row["content_hash"] == content_hash and row["settings_hash"] == settings_hash
            for row in self.parse_results
        )

    async def parse_artifact(
        self, content_hash: str, settings_hash: str
    ) -> ParseArtifactRow | None:
        row = self._row_for(content_hash, settings_hash)
        # The real query filters on `checkpoint IS NULL`, because a row with a
        # checkpoint is an ingest in progress rather than a cache entry. The
        # double has to do the same, or a resume test would pass by being
        # handed a half-finished parse as though it were finished.
        if row is None or row.get("checkpoint") is not None:
            return None
        return ParseArtifactRow(
            markdown=row["markdown"],
            contents=row["contents"],
            page_count=row["page_count"],
        )

    async def resume_point(
        self, content_hash: str, settings_hash: str
    ) -> tuple[ParseArtifactRow, dict[str, Any]] | None:
        row = self._row_for(content_hash, settings_hash)
        if row is None or row.get("checkpoint") is None:
            return None
        return (
            ParseArtifactRow(
                markdown=row["markdown"],
                contents=row["contents"],
                page_count=row["page_count"],
            ),
            row["checkpoint"],
        )

    def _row_for(self, content_hash: str, settings_hash: str) -> dict[str, Any] | None:
        for row in self.parse_results:
            if row["content_hash"] == content_hash and row["settings_hash"] == settings_hash:
                return row
        return None

    async def chunk_count(self, document_id: str) -> int:
        return len([row for row in self.chunks if row.document_id == document_id])

    async def embedding_dimensions(self) -> int | None:
        return self.declared_dimensions

    async def start_job(self, job_id: str, attempt: int, *, document_id: str | None = None) -> None:
        self.started.append((job_id, attempt))

    async def record_stage(
        self, *, job_id: str, document_id: str, stage: JobStage, percent: int
    ) -> None:
        self.stages.append((stage, percent))

    async def complete_job(self, **kwargs: Any) -> None:
        self.completed.append(kwargs)

    async def fail_job(self, **kwargs: Any) -> None:
        self.failures.append(kwargs)

    async def upsert_parse_result(self, **kwargs: Any) -> None:
        # The real statement updates on conflict *only while the existing row
        # still carries a checkpoint*, and does nothing otherwise. Both halves
        # matter here: without the update a batched parse could never extend
        # what the previous batch wrote, and without the guard a re-delivered
        # job would rewrite a finished parse other documents may be citing.
        existing = self._row_for(kwargs["content_hash"], kwargs["settings_hash"])
        if existing is None:
            self.parse_results.append(kwargs)
            return
        if existing.get("checkpoint") is None:
            return
        existing.update(kwargs)

    async def upsert_chunks(self, rows: list[ChunkRow]) -> None:
        # The real statement upserts on (document_id, ordinal); the double has
        # to replace rather than append, or an idempotency test would pass by
        # accumulating duplicates.
        by_key = {(row.document_id, row.ordinal): row for row in self.chunks}
        by_key.update({(row.document_id, row.ordinal): row for row in rows})
        self.chunks = [by_key[key] for key in sorted(by_key)]

    async def prune_chunks(self, *, document_id: str, keep: int) -> None:
        self.chunks = [
            row for row in self.chunks if row.document_id != document_id or row.ordinal < keep
        ]

    async def set_chunk_counts(self, *, document_id: str, ready: int, total: int) -> None:
        self.chunk_counts.append((ready, total))

    async def set_page_counts(self, *, document_id: str, ready: int, total: int | None) -> None:
        self.page_counts.append((ready, total))

    async def record_checkpoint(self, *, job_id: str, checkpoint: dict[str, Any] | None) -> None:
        self.job_checkpoints.append((job_id, checkpoint))

    async def mark_partially_ready(self, *, document_id: str) -> None:
        self.partially_ready.append(document_id)

    async def cancel_job(self, *, job_id: str, document_id: str, message: str) -> None:
        self.cancellations.append(
            {"job_id": job_id, "document_id": document_id, "message": message}
        )

    async def set_document_embedding(
        self, *, document_id: str, model: str | None, dims: int | None
    ) -> None:
        self.embedding_recorded.append((model, dims))

    async def upsert_pages(self, *, document_id: str, pages: list[PageRow]) -> None:
        # The real statement upserts on (document_id, page_no); the double has
        # to replace rather than append or a replay test would pass by
        # accumulating duplicates.
        by_page = {page.page_no: page for page in self.pages}
        by_page.update({page.page_no: page for page in pages})
        self.pages = [by_page[page_no] for page_no in sorted(by_page)]

    async def upsert_document_summary(self, *, document_id: str, summary: str | None) -> None:
        self.summaries[document_id] = summary

    async def upsert_document_embedding(
        self,
        *,
        embedding_id: str,
        document_id: str,
        org_id: str,
        embedding: list[float] | None,
    ) -> None:
        if embedding is not None:
            self.document_embeddings[document_id] = embedding


class FakeObjectStore:
    """Serves one local file as the document, and keeps every upload in memory.

    Standing in for S3 rather than running MinIO because what the pipeline tests
    ask about is the pipeline: does the hash get re-checked, does a thumbnail
    get written for every page, does a missing object fail terminally. The real
    client is exercised against real MinIO by the integration suite, which is
    where a signing or addressing bug would actually show up.
    """

    def __init__(self, source: Path | None = None) -> None:
        self.source = source
        self.uploads: dict[str, bytes] = {}
        self.content_types: dict[str, str] = {}
        self.downloads: list[str] = []

    async def download(self, key: str, destination: Path) -> None:
        self.downloads.append(key)
        if self.source is None:
            raise JobFailure(
                JobErrorCode.object_missing,
                "The uploaded file is no longer in storage.",
            )
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(self.source.read_bytes())

    async def put_bytes(self, key: str, body: bytes, *, content_type: str) -> None:
        self.uploads[key] = body
        self.content_types[key] = content_type

    async def ping(self) -> None:
        return None


class FakeQueue:
    """Records acknowledgements, retries, dead letters and published progress."""

    def __init__(self) -> None:
        self.consumer = "test-consumer"
        self.acked: list[str] = []
        self.retries: list[tuple[JobPayload, float]] = []
        self.dead: list[dict[str, Any]] = []
        self.published: list[JobProgress] = []
        self.enqueued: list[JobPayload] = []
        #: Job ids somebody has asked to stop, and the ones that were cleared.
        self.cancelled: set[str] = set()
        self.cleared: list[str] = []

    async def ensure_group(self) -> None:
        return None

    async def ack(self, entry_id: str) -> None:
        self.acked.append(entry_id)

    async def enqueue(self, payload: JobPayload) -> str:
        self.enqueued.append(payload)
        return f"{len(self.enqueued)}-0"

    async def schedule_retry(self, payload: JobPayload, *, delay_seconds: float) -> None:
        self.retries.append((payload, delay_seconds))

    async def dead_letter(
        self, *, raw: str, error_code: JobErrorCode, message: str, attempts: int
    ) -> None:
        self.dead.append(
            {"raw": raw, "error_code": error_code, "message": message, "attempts": attempts}
        )

    async def publish_progress(self, progress: JobProgress) -> None:
        self.published.append(progress)

    async def is_cancelled(self, job_id: str) -> bool:
        return job_id in self.cancelled

    async def request_cancel(self, job_id: str) -> None:
        self.cancelled.add(job_id)

    async def clear_cancel(self, job_id: str) -> None:
        self.cleared.append(job_id)
        self.cancelled.discard(job_id)

    async def read_own_pending(self, *, count: int) -> list[Any]:
        return []

    async def depth(self) -> dict[str, int]:
        return {"stream": 0, "pending": 0, "retrying": len(self.retries), "dead": len(self.dead)}
