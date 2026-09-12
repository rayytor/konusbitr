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
from konusbitr_worker.db import DocumentRecord, PageRow
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
        self.stages: list[tuple[JobStage, int]] = []
        self.started: list[tuple[str, int]] = []
        self.completed: list[dict[str, Any]] = []
        self.failures: list[dict[str, Any]] = []

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

    async def start_job(self, job_id: str, attempt: int) -> None:
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
        # The real statement is ON CONFLICT DO NOTHING on
        # (content_hash, settings_hash); the double has to behave the same way
        # or an idempotency test would pass for the wrong reason.
        if await self.parse_result_exists(kwargs["content_hash"], kwargs["settings_hash"]):
            return
        self.parse_results.append(kwargs)

    async def upsert_pages(self, *, document_id: str, pages: list[PageRow]) -> None:
        # The real statement upserts on (document_id, page_no); the double has
        # to replace rather than append or a replay test would pass by
        # accumulating duplicates.
        by_page = {page.page_no: page for page in self.pages}
        by_page.update({page.page_no: page for page in pages})
        self.pages = [by_page[page_no] for page_no in sorted(by_page)]


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

    async def read_own_pending(self, *, count: int) -> list[Any]:
        return []

    async def depth(self) -> dict[str, int]:
        return {"stream": 0, "pending": 0, "retrying": len(self.retries), "dead": len(self.dead)}
