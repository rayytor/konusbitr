"""Embedding a document's chunks and storing them.

Three properties this module exists to provide, in the order they matter.

**A second delivery is a no-op.** Every chunk is upserted on
`(document_id, ordinal)`, so a job re-delivered after a crash overwrites the
rows it had already written instead of appending a second copy. Chunks beyond
the new count are deleted, which is what makes a *re-chunk* — a reindex after
the chunker changed and now produces forty chunks where it produced fifty —
leave forty rows rather than forty new ones and ten stale ones.

**A partial failure re-embeds only what failed.** Batches are embedded and
written one at a time. If batch nine of twelve times out, the eight before it
are already in the database and the retry covers batch nine. Re-embedding the
whole document for every transient blip would triple the cost of a large one.

**Progress is real.** `embedding` runs from 85% to 95% in proportion to the
chunks written, so the Phase 06 SSE stream shows a bar that moves rather than a
spinner — and `documents.chunks_ready` is updated as they land, so Phase 10's
chat can answer over the first part of a long document while the rest is still
going.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence

from konusbitr_worker.ai import EmbeddingRouter
from konusbitr_worker.chunk.chunker import Chunk
from konusbitr_worker.db import ChunkRow, Database
from konusbitr_worker.ids import ID_PREFIXES, new_id
from konusbitr_worker.log import get_logger

__all__ = ["EmbedReport", "ProgressCallback", "embed_and_store"]

logger = get_logger("konusbitr.worker.chunk.embed")

#: Called with the number of chunks written so far and the total.
ProgressCallback = Callable[[int, int], Awaitable[None]]


class EmbedReport:
    """What one embed pass did, for the job result and the log."""

    __slots__ = ("dims", "embedded", "model", "total")

    def __init__(self, *, total: int, embedded: int, model: str | None, dims: int | None) -> None:
        self.total = total
        self.embedded = embedded
        self.model = model
        self.dims = dims

    def to_json(self) -> dict[str, object]:
        return {
            "chunks": self.total,
            "embedded": self.embedded,
            "embeddingModel": self.model,
            "dims": self.dims,
        }


async def embed_and_store(
    chunks: Sequence[Chunk],
    *,
    database: Database,
    org_id: str,
    document_id: str,
    router: EmbeddingRouter | None,
    on_progress: ProgressCallback | None = None,
) -> EmbedReport:
    """Write a document's chunks, with vectors when a model is configured.

    `router` is `None` when nothing is configured, and that is a supported
    state rather than an error: the chunks are written without vectors, the
    document is keyword-searchable immediately, and the `reindex` that follows
    configuring a model fills the vectors in. It is the same shape as `SMTP_URL`
    being unset — the feature degrades to something coherent and says so — and
    it is what keeps `cp .env.example .env && docker compose up` a working
    stack rather than one that needs an API key before it will finish a job.
    """
    total = len(chunks)
    if total == 0:
        await database.set_chunk_counts(document_id=document_id, ready=0, total=0)
        return EmbedReport(total=0, embedded=0, model=None, dims=None)

    if router is None:
        await _store(chunks, database=database, org_id=org_id, document_id=document_id)
        await database.set_chunk_counts(document_id=document_id, ready=0, total=total)
        await database.prune_chunks(document_id=document_id, keep=total)
        logger.info(
            "stored chunks without vectors; no embedding model is configured",
            extra={"chunks": total},
        )
        if on_progress is not None:
            await on_progress(total, total)
        return EmbedReport(total=total, embedded=0, model=None, dims=None)

    # Checked against the column rather than only against the configured width:
    # `EMBEDDING_DIMENSIONS` and the DDL are two places one number lives, and
    # the operator who changed one and not the other needs to be told which,
    # before a batch insert fails from inside Postgres.
    declared = await database.embedding_dimensions()
    if declared is not None and declared != router.dimensions:
        raise ValueError(
            f"EMBEDDING_DIMENSIONS is {router.dimensions} but chunks.embedding is "
            f"vector({declared}). Bring them into line and reindex every document — "
            "a mixed index returns nonsense rather than failing."
        )

    written = 0
    for offset, batch in router.batches([chunk.text for chunk in chunks]):
        vectors = await router.embed(batch)
        await _store(
            chunks[offset : offset + len(batch)],
            database=database,
            org_id=org_id,
            document_id=document_id,
            vectors=vectors,
        )
        written += len(batch)
        # Written after each batch, not at the end: it is what a reader of
        # `chunks_ready` is promised, and a count that only becomes true at the
        # end would make partial readiness a lie.
        await database.set_chunk_counts(document_id=document_id, ready=written, total=total)
        if on_progress is not None:
            await on_progress(written, total)

    await database.prune_chunks(document_id=document_id, keep=total)
    await database.set_document_embedding(
        document_id=document_id, model=router.model_name, dims=router.dimensions
    )
    logger.info(
        "embedded and stored chunks",
        extra={"chunks": total, "model": router.model_name, "dims": router.dimensions},
    )
    return EmbedReport(
        total=total, embedded=written, model=router.model_name, dims=router.dimensions
    )


async def _store(
    chunks: Sequence[Chunk],
    *,
    database: Database,
    org_id: str,
    document_id: str,
    vectors: Sequence[Sequence[float]] | None = None,
) -> None:
    rows = [
        ChunkRow(
            id=new_id(ID_PREFIXES["chunk"]),
            document_id=document_id,
            org_id=org_id,
            ordinal=chunk.ordinal,
            section_path=chunk.section_path,
            text=chunk.text,
            token_count=chunk.token_count,
            pages=chunk.pages,
            meta=chunk.to_meta(),
            embedding=list(vectors[index]) if vectors is not None else None,
        )
        for index, chunk in enumerate(chunks)
    ]
    await database.upsert_chunks(rows)
