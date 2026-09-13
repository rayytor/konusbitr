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

__all__ = [
    "STAGE_TO_STATUS",
    "ChunkRow",
    "Database",
    "DocumentRecord",
    "PageRow",
    "ParseArtifactRow",
]

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
class PageRow:
    """One row of `pages`, as the pipeline hands it over.

    Width and height are integers because the column is: a page dimension in
    points is a whole number on every real document, and a float column would
    invite the viewer to believe in precision the source does not have.
    """

    id: str
    page_no: int
    width: int
    height: int
    thumbnail_key: str | None = None


@dataclass(frozen=True, slots=True)
class ChunkRow:
    """One row of `chunks`, as the chunker hands it over.

    `pages` is never empty and `ordinal` is never absent: a chunk that cannot
    say where it came from cannot be cited, and `(document_id, ordinal)` is the
    key an upsert conflicts on. Both columns are `NOT NULL` for those reasons.

    `embedding` is `None` on a deployment with no embedding model configured.
    The chunk is still stored and still keyword-searchable; the vector arrives
    with the `reindex` that follows configuring one.
    """

    id: str
    document_id: str
    org_id: str
    ordinal: int
    section_path: str | None
    text: str
    token_count: int
    pages: list[dict[str, Any]]
    meta: dict[str, Any] | None = None
    embedding: list[float] | None = None


@dataclass(frozen=True, slots=True)
class ParseArtifactRow:
    """A cached parse, read back out of the docId cache.

    This is what makes a `reindex` cheap and what makes a cache hit finish the
    job properly rather than short-circuiting it: the artifact that Docling
    produced weeks ago is the chunker's input verbatim, so re-chunking a
    document never re-parses one.
    """

    markdown: str | None
    contents: dict[str, Any] | None
    page_count: int | None


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

    async def parse_artifact(
        self, content_hash: str, settings_hash: str
    ) -> ParseArtifactRow | None:
        """The cached parse for these bytes and settings, if there is one.

        Not scoped to an organization, and that is correct: the row is keyed on
        hashes precisely so a second tenant's identical file can point at the
        same parse without copying it. Nothing about *who may read a document*
        is decided here — that is settled by the org-scoped `document` lookup
        the caller has already done before it gets this far.
        """
        row = await self._pool.fetchrow(
            """
            SELECT markdown, contents, page_count
              FROM parse_results
             WHERE content_hash = $1 AND settings_hash = $2
            """,
            content_hash,
            settings_hash,
        )
        if row is None:
            return None
        contents = row["contents"]
        return ParseArtifactRow(
            markdown=row["markdown"],
            # asyncpg hands back `jsonb` as text unless a codec is registered,
            # and registering one globally would change every other query's
            # shape. Decoding here keeps the surprise local.
            contents=json.loads(contents) if isinstance(contents, str) else contents,
            page_count=row["page_count"],
        )

    async def chunk_count(self, document_id: str) -> int:
        """How many chunks a document already has.

        Read before chunking so that a re-delivered `parse` job does not redo
        the embedding it already paid for. A `reindex` ignores it on purpose:
        its whole reason to exist is that the existing chunks are stale.
        """
        return int(
            await self._pool.fetchval(
                "SELECT count(*) FROM chunks WHERE document_id = $1", document_id
            )
            or 0
        )

    async def embedding_dimensions(self) -> int | None:
        """The declared width of `chunks.embedding`, from the catalogue.

        Asked rather than assumed because the number lives in three places —
        the DDL, `EMBEDDING_DIMENSIONS`, and whatever the model actually
        returns — and the failure when they disagree is an insert error from
        deep inside a batch. Read here, the message can name the variable.

        `atttypmod` is how pgvector stores the dimension; `-1` means the column
        is untyped, which the schema forbids (an HNSW index cannot be built on
        one) but which a hand-altered database could still present.
        """
        value = await self._pool.fetchval(
            """
            SELECT atttypmod
              FROM pg_attribute
             WHERE attrelid = 'chunks'::regclass
               AND attname = 'embedding'
               AND NOT attisdropped
            """
        )
        if value is None or int(value) < 0:
            return None
        return int(value)

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
        tenant's document, and overwriting its `document_id` would mutate
        provenance. `document_id` records initial provenance with ON DELETE
        SET NULL, decoupling cache longevity from the document that produced it.
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

    async def upsert_chunks(self, rows: list[ChunkRow]) -> None:
        """Write a batch of chunks, replacing whatever held those ordinals.

        `ON CONFLICT (document_id, ordinal) DO UPDATE` is the whole idempotency
        story for this phase. Delivery is at-least-once, so a job killed
        halfway and redelivered writes ordinals 0..40 a second time — and must
        leave forty-one rows, not eighty-two. The conflict target is exactly the
        unique index migration 0005 adds.

        `id` is not updated on conflict: a chunk that already exists keeps the
        id a citation may already be pointing at. Everything else is replaced,
        because a reindex is *meant* to change the text and the vector.

        `embedding` is cast rather than passed as a list because asyncpg has no
        codec for pgvector's type; the literal `[0.1,0.2,…]` form is what the
        extension parses, and it is the same form Drizzle's custom type emits on
        the TypeScript side.
        """
        if not rows:
            return

        await self._pool.executemany(
            """
            INSERT INTO chunks (
                id, document_id, org_id, ordinal, section_path,
                text, token_count, pages, meta, embedding
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::vector)
            ON CONFLICT (document_id, ordinal)
            DO UPDATE SET org_id = EXCLUDED.org_id,
                          section_path = EXCLUDED.section_path,
                          text = EXCLUDED.text,
                          token_count = EXCLUDED.token_count,
                          pages = EXCLUDED.pages,
                          meta = EXCLUDED.meta,
                          embedding = EXCLUDED.embedding
            """,
            [
                (
                    row.id,
                    row.document_id,
                    row.org_id,
                    row.ordinal,
                    row.section_path,
                    row.text,
                    row.token_count,
                    json.dumps(row.pages),
                    json.dumps(row.meta) if row.meta is not None else None,
                    _vector_literal(row.embedding),
                )
                for row in rows
            ],
        )

    async def prune_chunks(self, *, document_id: str, keep: int) -> None:
        """Delete chunks past the end of the new chunking.

        The other half of an idempotent re-chunk. Upserting ordinals 0..39 over
        a document that had fifty chunks leaves ten stale rows behind — with
        stale text, stale vectors, and ids that retrieval would happily return.
        A document with no chunks at all is the `keep=0` case, which is a
        legitimate reindex of a document whose parse turned out to be empty.
        """
        await self._pool.execute(
            "DELETE FROM chunks WHERE document_id = $1 AND ordinal >= $2",
            document_id,
            keep,
        )

    async def set_chunk_counts(self, *, document_id: str, ready: int, total: int) -> None:
        """Partial readiness, updated as chunks land.

        Written per batch rather than once at the end, because that is what a
        reader of `chunks_ready` is promised: Phase 10's chat answers over the
        part of a long document that is ready while the rest is still
        embedding, and a count that only became true at the end would make the
        whole idea a lie.
        """
        await self._pool.execute(
            """
            UPDATE documents
               SET chunks_ready = $2, chunks_total = $3, updated_at = now()
             WHERE id = $1
            """,
            document_id,
            ready,
            total,
        )

    async def set_document_embedding(
        self, *, document_id: str, model: str | None, dims: int | None
    ) -> None:
        """Record which model produced this document's vectors.

        On the document rather than on each chunk because it is a property of
        the index: one document is embedded by one model in one pass, and mixing
        two embedding spaces inside a single similarity search does not fail —
        it silently returns nonsense. Storing the model is what lets a
        deployment that has changed `EMBEDDING_MODEL` find the documents that
        still need a reindex.
        """
        await self._pool.execute(
            """
            UPDATE documents
               SET embedding_model = $2, dims = $3, updated_at = now()
             WHERE id = $1
            """,
            document_id,
            model,
            dims,
        )

    async def upsert_pages(self, *, document_id: str, pages: list[PageRow]) -> None:
        """Replace this document's page geometry.

        Keyed on `(document_id, page_no)`, so a replay overwrites rather than
        duplicates. Width and height are in the one coordinate convention —
        PDF points, origin top-left, rotation already applied — that
        `docs/coordinates.md` describes and the viewer assumes.

        `thumbnail_key` is coalesced rather than assigned, so a re-delivery that
        has not re-rendered the thumbnails does not blank out keys that point
        at objects still sitting in the bucket.
        """
        if not pages:
            return

        await self._pool.executemany(
            """
            INSERT INTO pages (id, document_id, page_no, width, height, thumbnail_key)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (document_id, page_no)
            DO UPDATE SET width = EXCLUDED.width,
                          height = EXCLUDED.height,
                          thumbnail_key = COALESCE(EXCLUDED.thumbnail_key, pages.thumbnail_key)
            """,
            [
                (page.id, document_id, page.page_no, page.width, page.height, page.thumbnail_key)
                for page in pages
            ],
        )

    async def upsert_document_summary(self, *, document_id: str, summary: str | None) -> None:
        """Store the ~200-token abstract on `documents.summary`."""
        await self._pool.execute(
            """
            UPDATE documents
               SET summary = $2, updated_at = now()
             WHERE id = $1
            """,
            document_id,
            summary,
        )

    async def upsert_document_embedding(
        self,
        *,
        embedding_id: str,
        document_id: str,
        org_id: str,
        embedding: list[float] | None,
    ) -> None:
        """Upsert the summary embedding for two-stage retrieval."""
        if embedding is None:
            return
        await self._pool.execute(
            """
            INSERT INTO document_embeddings (id, document_id, org_id, embedding)
            VALUES ($1, $2, $3, $4::text::vector)
            ON CONFLICT (document_id)
            DO UPDATE SET embedding = EXCLUDED.embedding, created_at = now()
            """,
            embedding_id,
            document_id,
            org_id,
            _vector_literal(embedding),
        )


def _vector_literal(embedding: list[float] | None) -> str | None:
    """pgvector's text form, which is what `$n::vector` parses.

    `None` stays `None`: a chunk with no vector is a chunk on a deployment with
    no embedding model configured, and `NULL` is the honest column value for it
    — it is also what makes `count(embedding)` a working measure of how much of
    a document is densely retrievable.
    """
    if embedding is None:
        return None
    return f"[{','.join(repr(float(value)) for value in embedding)}]"
