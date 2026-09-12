"""The worker's own, very small, database layer.

Konusbitr runs two languages with one hard seam between them, and the rule is
that nothing crosses it except a Redis queue and JSON payloads — no shared ORM,
no shared data-access layer, no import in either direction. This module is what
that rule looks like from the Python side: raw SQL over ``asyncpg``, written
here, owned here, and deliberately narrow. Drizzle's schema is the source of
truth for the *tables*; it is not, and must not become, a dependency of this
service.

Every statement below is an upsert or an unconditional update keyed on an id,
because the queue is at-least-once. A job re-delivered after a worker was killed
mid-run replays these writes and must leave the database exactly as a single
clean run would — that is what "completes the job exactly once" means when the
transport itself cannot promise it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Self

import asyncpg

from konusbitr_worker.contracts import DocumentStatus, JobStage

__all__ = ["STAGE_TO_STATUS", "Database", "DocumentRecord"]

#: How a pipeline stage is reported as a document status.
#:
#: The stages are finer-grained than the six statuses a person sees, on purpose:
#: "fetching" and "validating" are both just *parsing* to someone watching a
#: spinner, and promoting them to statuses of their own would put wording in a
#: database column that belongs in a progress message.
STAGE_TO_STATUS: dict[JobStage, DocumentStatus] = {
    JobStage.queued: DocumentStatus.queued,
    JobStage.fetching: DocumentStatus.parsing,
    JobStage.validating: DocumentStatus.parsing,
    JobStage.parsing: DocumentStatus.parsing,
    JobStage.ocr: DocumentStatus.ocr,
    JobStage.chunking: DocumentStatus.embedding,
    JobStage.embedding: DocumentStatus.embedding,
    JobStage.persisting: DocumentStatus.embedding,
    JobStage.ready: DocumentStatus.ready,
    JobStage.failed: DocumentStatus.failed,
}


@dataclass(frozen=True, slots=True)
class DocumentRecord:
    """The columns the pipeline actually reads."""

    id: str
    org_id: str
    filename: str
    mime: str
    byte_size: int
    page_count: int | None
    storage_key: str
    content_hash: str
    settings_hash: str
    status: str


class Database:
    """An ``asyncpg`` pool plus the handful of statements the worker issues."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    @classmethod
    async def connect(cls, dsn: str, *, min_size: int = 1, max_size: int = 8) -> Self:
        # asyncpg does not understand the `postgresql+driver://` forms and is
        # strict about `postgres://`; both spellings are in `.env.example`'s
        # blast radius, so normalise rather than fail on a valid URL.
        pool = await asyncpg.create_pool(
            dsn.replace("postgresql://", "postgres://", 1),
            min_size=min_size,
            max_size=max_size,
        )
        if pool is None:  # pragma: no cover - asyncpg only returns None on a bad loop
            raise RuntimeError("could not create a database pool")
        return cls(pool)

    async def close(self) -> None:
        await self._pool.close()

    async def ping(self) -> None:
        """Raise if Postgres is not answering. Used by ``/ready``."""
        await self._pool.fetchval("SELECT 1")

    # ── Reads ────────────────────────────────────────────────────────────────

    async def document(self, document_id: str, org_id: str) -> DocumentRecord | None:
        """One document, scoped to the organization the payload claims.

        The `org_id` predicate is not decoration. A job payload arrives from a
        queue rather than from the endpoint that validated the upload, so the
        worker treats it as a message and not as an authority: a payload naming
        another tenant's document finds nothing, exactly as it should.
        """
        row = await self._pool.fetchrow(
            """
            SELECT id, org_id, filename, mime, byte_size, page_count,
                   storage_key, content_hash, settings_hash, status
              FROM documents
             WHERE id = $1 AND org_id = $2
            """,
            document_id,
            org_id,
        )
        return None if row is None else DocumentRecord(**dict(row))

    async def parse_result_exists(self, content_hash: str, settings_hash: str) -> bool:
        """Whether these bytes at these settings have already been parsed."""
        return bool(
            await self._pool.fetchval(
                """
                SELECT 1 FROM parse_results
                 WHERE content_hash = $1 AND settings_hash = $2
                """,
                content_hash,
                settings_hash,
            )
        )

    # ── Job lifecycle ────────────────────────────────────────────────────────

    async def start_job(self, job_id: str, attempt: int) -> None:
        await self._pool.execute(
            """
            UPDATE jobs
               SET status = 'running',
                   stage = $2,
                   attempts = GREATEST(attempts, $3),
                   error = NULL,
                   error_code = NULL,
                   updated_at = now()
             WHERE id = $1
            """,
            job_id,
            JobStage.fetching.value,
            attempt,
        )

    async def record_stage(
        self,
        *,
        job_id: str,
        document_id: str,
        stage: JobStage,
        percent: int,
    ) -> None:
        """Persist the progress that the pub/sub event only broadcasts.

        Both halves matter and neither replaces the other: the published event
        is what a connected browser sees within milliseconds, and this row is
        what a browser that reconnects reads to find out where things got to
        while it was away.
        """
        async with self._pool.acquire() as connection, connection.transaction():
            await connection.execute(
                """
                UPDATE jobs
                   SET stage = $2, progress = $3, updated_at = now()
                 WHERE id = $1
                """,
                job_id,
                stage.value,
                percent,
            )
            await connection.execute(
                """
                UPDATE documents
                   SET status = $2, updated_at = now()
                 WHERE id = $1
                """,
                document_id,
                STAGE_TO_STATUS[stage].value,
            )

    async def complete_job(
        self,
        *,
        job_id: str,
        document_id: str,
        page_count: int | None,
        result: dict[str, Any] | None = None,
    ) -> None:
        async with self._pool.acquire() as connection, connection.transaction():
            await connection.execute(
                """
                UPDATE jobs
                   SET status = 'succeeded',
                       stage = $2,
                       progress = 100,
                       error = NULL,
                       error_code = NULL,
                       result = $3::jsonb,
                       updated_at = now()
                 WHERE id = $1
                """,
                job_id,
                JobStage.ready.value,
                json.dumps(result) if result is not None else None,
            )
            await connection.execute(
                """
                UPDATE documents
                   SET status = $2,
                       page_count = COALESCE($3, page_count),
                       error = NULL,
                       error_code = NULL,
                       updated_at = now()
                 WHERE id = $1
                """,
                document_id,
                DocumentStatus.ready.value,
                page_count,
            )

    async def fail_job(
        self,
        *,
        job_id: str,
        document_id: str,
        error_code: str,
        message: str,
        terminal: bool,
    ) -> None:
        """Record a failure, and mark the document failed only if it is final.

        A retryable failure leaves the document in whatever stage it reached.
        Flipping it to `failed` between attempts would show a person a document
        that has died and then, a few seconds later, one that is parsing again
        — which reads as a bug even when the retry succeeds.
        """
        async with self._pool.acquire() as connection, connection.transaction():
            await connection.execute(
                """
                UPDATE jobs
                   SET status = $2,
                       stage = $3,
                       error = $4,
                       error_code = $5,
                       updated_at = now()
                 WHERE id = $1
                """,
                job_id,
                "failed" if terminal else "pending",
                JobStage.failed.value if terminal else JobStage.queued.value,
                message,
                error_code,
            )
            if terminal:
                await connection.execute(
                    """
                    UPDATE documents
                       SET status = $2, error = $3, error_code = $4, updated_at = now()
                     WHERE id = $1
                    """,
                    document_id,
                    DocumentStatus.failed.value,
                    message,
                    error_code,
                )

    async def failed_jobs(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = await self._pool.fetch(
            """
            SELECT id, org_id, document_id, type, stage, error, error_code, attempts, updated_at
              FROM jobs
             WHERE status = 'failed'
             ORDER BY updated_at DESC
             LIMIT $1
            """,
            limit,
        )
        return [dict(row) for row in rows]

    # ── Pipeline output ──────────────────────────────────────────────────────

    async def upsert_parse_result(
        self,
        *,
        parse_result_id: str,
        document_id: str,
        content_hash: str,
        settings_hash: str,
        quality: str,
        lang_list: list[str],
        llm_enabled: bool,
        markdown: str | None,
        contents: dict[str, Any] | None,
        page_count: int | None,
    ) -> None:
        """Write the parse into the docId cache.

        `ON CONFLICT DO NOTHING` rather than an update, for two reasons. A
        re-delivered job must be a no-op, which is the point of this phase. And
        the unique key is `(content_hash, settings_hash)` with no organization
        in it — so the row that is already there may belong to a *different*
        tenant's document, and overwriting its `document_id` would silently
        take their parse away from them.
        """
        await self._pool.execute(
            """
            INSERT INTO parse_results (
                id, document_id, content_hash, settings_hash,
                quality, lang_list, llm_enabled, markdown, contents, page_count
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
            ON CONFLICT (content_hash, settings_hash) DO NOTHING
            """,
            parse_result_id,
            document_id,
            content_hash,
            settings_hash,
            quality,
            lang_list,
            llm_enabled,
            markdown,
            json.dumps(contents) if contents is not None else None,
            page_count,
        )

    async def upsert_pages(
        self,
        *,
        document_id: str,
        pages: list[tuple[str, int, int, int]],
    ) -> None:
        """Replace this document's page geometry.

        Keyed on `(document_id, page_no)`, so a replay overwrites rather than
        duplicates. Width and height are in the one coordinate convention —
        PDF points, origin top-left — that `docs/coordinates.md` describes and
        the viewer assumes.
        """
        if not pages:
            return

        await self._pool.executemany(
            """
            INSERT INTO pages (id, document_id, page_no, width, height)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (document_id, page_no)
            DO UPDATE SET width = EXCLUDED.width, height = EXCLUDED.height
            """,
            [
                (page_id, document_id, page_no, width, height)
                for page_id, page_no, width, height in pages
            ],
        )
