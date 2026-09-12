"""Embedding a document's chunks and storing them.

Four properties, in the order they matter: a second delivery does not double
anything, a partial failure re-embeds only what failed, a width mismatch is
refused rather than discovered inside Postgres, and a deployment with no
embedding model configured still stores chunks.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from konusbitr_worker.ai.tokens import Tokenizer
from konusbitr_worker.chunk import ChunkingOptions, chunk_elements, elements_from_contents
from konusbitr_worker.chunk.embed import embed_and_store
from tests.factories import FakeDatabase, make_document

pytestmark = pytest.mark.asyncio

DIMS = 1024


class FakeRouter:
    """Stands in for the LiteLLM router, counting calls and failing on demand."""

    def __init__(
        self,
        *,
        batch_size: int = 2,
        dims: int = DIMS,
        fail_on: set[int] | None = None,
        model: str = "ollama/bge-m3",
    ) -> None:
        self.batch_size = batch_size
        self.dimensions = dims
        self.model_name = model
        self.tokenizer = Tokenizer("text-embedding-3-large")
        self.calls: list[list[str]] = []
        self._fail_on = fail_on or set()

    def batches(self, texts: list[str]) -> Iterator[tuple[int, list[str]]]:
        for start in range(0, len(texts), self.batch_size):
            yield start, list(texts[start : start + self.batch_size])

    async def embed(self, texts: list[str]) -> list[list[float]]:
        index = len(self.calls)
        self.calls.append(list(texts))
        if index in self._fail_on:
            raise RuntimeError("the provider timed out")
        return [[0.1] * self.dimensions for _ in texts]


def chunks_of(paragraphs: int) -> list[Any]:
    """Chunks built from `paragraphs` page-sized paragraphs.

    The count of *chunks* is whatever the chunker decides, which is the point —
    the tests below assert against `len(chunks)` rather than against a number
    written here, so a change to the band does not turn into a wrong assertion
    about embedding.
    """
    contents = [
        {
            "id": f"el_{index:04d}",
            "type": "paragraph",
            "text": " ".join(f"item{n} counts." for n in range(200)),
            "markdown": " ".join(f"item{n} counts." for n in range(200)),
            "page": 1 + index,
            "bbox": [72, 100, 540, 700],
            "sectionPath": [],
        }
        for index in range(paragraphs)
    ]
    return chunk_elements(
        elements_from_contents(contents),
        tokenizer=Tokenizer("text-embedding-3-large"),
        options=ChunkingOptions(),
    )


async def test_chunks_are_stored_with_their_vectors() -> None:
    database = FakeDatabase(make_document())
    chunks = chunks_of(6)
    router = FakeRouter()

    report = await embed_and_store(
        chunks,
        database=database,
        org_id="org_test",
        document_id="doc_test",
        router=router,
    )

    assert report.total == len(chunks)
    assert report.embedded == len(chunks)
    assert report.model == "ollama/bge-m3"
    assert len(database.chunks) == len(chunks)
    assert all(row.embedding is not None and len(row.embedding) == DIMS for row in database.chunks)
    assert database.embedding_recorded == [("ollama/bge-m3", DIMS)]


async def test_a_rerun_does_not_duplicate_chunks() -> None:
    """The idempotency criterion, where it is decided: the upsert key.

    Delivery is at-least-once, so a job killed halfway and redelivered writes
    the same ordinals again — and must leave one row per ordinal.
    """
    database = FakeDatabase(make_document())
    chunks = chunks_of(6)

    for _ in range(2):
        await embed_and_store(
            chunks,
            database=database,
            org_id="org_test",
            document_id="doc_test",
            router=FakeRouter(),
        )

    assert len(database.chunks) == len(chunks)
    assert [row.ordinal for row in database.chunks] == list(range(len(chunks)))


async def test_a_re_chunk_that_produces_fewer_chunks_leaves_none_behind() -> None:
    """The other half of an idempotent re-chunk.

    Upserting ordinals 0..2 over a document that had six chunks would otherwise
    leave three stale rows — stale text, stale vectors, and ids retrieval would
    happily return.
    """
    database = FakeDatabase(make_document())

    await embed_and_store(
        chunks_of(9),
        database=database,
        org_id="org_test",
        document_id="doc_test",
        router=FakeRouter(),
    )
    before = len(database.chunks)

    fewer = chunks_of(2)
    await embed_and_store(
        fewer,
        database=database,
        org_id="org_test",
        document_id="doc_test",
        router=FakeRouter(),
    )

    assert before > len(fewer)
    assert len(database.chunks) == len(fewer)
    assert max(row.ordinal for row in database.chunks) == len(fewer) - 1


async def test_a_failed_batch_leaves_the_successful_ones_written() -> None:
    """So the retry re-embeds one batch rather than the whole document.

    Re-embedding everything for every transient blip would triple the cost of a
    large document, which is the difference between a rate limit being an
    inconvenience and being an outage.
    """
    database = FakeDatabase(make_document())
    chunks = chunks_of(6)
    router = FakeRouter(batch_size=2, fail_on={2})

    with pytest.raises(RuntimeError):
        await embed_and_store(
            chunks,
            database=database,
            org_id="org_test",
            document_id="doc_test",
            router=router,
        )

    # Two batches of two landed before the third failed.
    assert len(database.chunks) == 4
    assert [row.ordinal for row in database.chunks] == [0, 1, 2, 3]
    # And the counts a reader sees reflect exactly that.
    assert database.chunk_counts[-1] == (4, len(chunks))


async def test_progress_is_reported_per_batch_rather_than_at_the_end() -> None:
    database = FakeDatabase(make_document())
    chunks = chunks_of(6)
    seen: list[tuple[int, int]] = []

    async def on_progress(written: int, total: int) -> None:
        seen.append((written, total))

    await embed_and_store(
        chunks,
        database=database,
        org_id="org_test",
        document_id="doc_test",
        router=FakeRouter(batch_size=2),
        on_progress=on_progress,
    )

    assert len(seen) > 1
    assert [written for written, _total in seen] == sorted(written for written, _ in seen)
    assert seen[-1] == (len(chunks), len(chunks))


async def test_chunks_are_stored_without_vectors_when_nothing_is_configured() -> None:
    """An unconfigured stack is a supported state, not a failure.

    It is the same shape as `SMTP_URL` being unset: the feature degrades to
    something coherent — the chunks are keyword-searchable immediately — and the
    vectors arrive with the reindex that follows configuring a model. It is also
    what keeps `cp .env.example .env && docker compose up` a working stack.
    """
    database = FakeDatabase(make_document())
    chunks = chunks_of(4)

    report = await embed_and_store(
        chunks,
        database=database,
        org_id="org_test",
        document_id="doc_test",
        router=None,
    )

    assert report.total == len(chunks)
    assert report.embedded == 0
    assert report.model is None
    assert len(database.chunks) == len(chunks)
    assert all(row.embedding is None for row in database.chunks)
    # Nothing is claimed about an index that does not exist.
    assert database.embedding_recorded == []
    assert database.chunk_counts[-1] == (0, len(chunks))


async def test_a_width_the_column_cannot_hold_is_refused_by_name() -> None:
    """A mixed index does not fail; it silently returns nonsense.

    So the disagreement is caught before the first insert, with a message that
    names the variable rather than an error from inside a batch.
    """
    database = FakeDatabase(make_document())
    database.declared_dimensions = 1024

    with pytest.raises(ValueError, match="EMBEDDING_DIMENSIONS"):
        await embed_and_store(
            chunks_of(2),
            database=database,
            org_id="org_test",
            document_id="doc_test",
            router=FakeRouter(dims=768),
        )

    assert database.chunks == []


async def test_an_untyped_vector_column_is_not_second_guessed() -> None:
    # The schema forbids one — pgvector cannot build an HNSW index over it —
    # but a hand-altered database could present it, and refusing to write
    # anything at all would be worse than trusting the configured width.
    database = FakeDatabase(make_document())
    database.declared_dimensions = None

    report = await embed_and_store(
        chunks_of(2),
        database=database,
        org_id="org_test",
        document_id="doc_test",
        router=FakeRouter(dims=768),
    )

    assert report.embedded == report.total > 0


async def test_a_document_with_no_chunks_records_zero_rather_than_nothing() -> None:
    database = FakeDatabase(make_document())

    report = await embed_and_store(
        [], database=database, org_id="org_test", document_id="doc_test", router=FakeRouter()
    )

    assert report.total == 0
    assert database.chunk_counts == [(0, 0)]
