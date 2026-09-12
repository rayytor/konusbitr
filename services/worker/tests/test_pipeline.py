"""The pipeline: the guards around the parse, and the writes after it.

Everything here is about the parts that must hold regardless of which parser
ran. The lookup is org-scoped, the content hash is re-checked against the bytes
rather than trusted from the payload, a parse that already exists short-circuits
instead of being redone, and every write survives a second delivery. Those four
are what make an at-least-once queue safe, and they are cheap to test because
none of them need Docling.

The parse itself — markdown fidelity, bounding boxes, tables — is covered by
`test_parse_fixtures.py`, which runs the real thing over the real corpus.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from konusbitr_worker.ai.resilience import ModelCallError
from konusbitr_worker.contracts import STAGE_PERCENT, JobErrorCode, JobStage
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.parse.artifact import (
    ElementType,
    ParseArtifact,
    ParsedElement,
    ParsedPage,
)
from konusbitr_worker.parse.geometry import BBox
from konusbitr_worker.pipeline import run_job
from konusbitr_worker.progress import ProgressReporter
from konusbitr_worker.settings import Settings
from tests.factories import (
    BASE_ENV,
    FakeDatabase,
    FakeObjectStore,
    FakeQueue,
    make_document,
    make_payload,
)

pytestmark = pytest.mark.asyncio


def reporter(payload: Any, queue: Any, database: Any) -> ProgressReporter:
    return ProgressReporter(payload=payload, queue=queue, database=database)


async def test_a_parse_walks_the_stages_and_writes_its_result(
    settings: Settings, queue: FakeQueue, stub_parse: list[dict[str, Any]]
) -> None:
    payload = make_payload()
    database = FakeDatabase(make_document(page_count=2))

    outcome = await run_job(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
        store=FakeObjectStore(),
    )

    assert outcome.page_count == 2
    assert outcome.reused is False
    assert len(database.parse_results) == 1
    assert database.parse_results[0]["content_hash"] == payload.contentHash
    assert [page.page_no for page in database.pages] == [1, 2]

    stages = [stage for stage, _percent in database.stages]
    assert stages == [
        JobStage.fetching,
        JobStage.validating,
        JobStage.parsing,
        JobStage.chunking,
        JobStage.embedding,
        # One `embedding` event per batch written, then the final save. With no
        # embedding model configured the chunks are still stored, so the bar
        # still reaches the end.
        JobStage.embedding,
        JobStage.persisting,
    ]


async def test_the_parse_is_given_the_row_rather_than_the_payload(
    settings: Settings, queue: FakeQueue, stub_parse: list[dict[str, Any]]
) -> None:
    """The payload is a message; the document row is the record.

    A payload that named a different storage key would otherwise have the
    worker fetch and parse bytes the web app never associated with this
    document.
    """
    payload = make_payload(storageKey="orgs/org_test/documents/doc_other/original.pdf")
    document = make_document()
    database = FakeDatabase(document)

    await run_job(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
        store=FakeObjectStore(),
    )

    assert stub_parse[0]["storage_key"] == document.storage_key
    assert stub_parse[0]["content_hash"] == document.content_hash
    assert stub_parse[0]["org_id"] == document.org_id


async def test_page_geometry_is_stored_in_the_visible_frame(
    settings: Settings, queue: FakeQueue, stub_parse: list[dict[str, Any]]
) -> None:
    """Rounded to the integer columns, rotation already applied."""
    payload = make_payload()
    database = FakeDatabase(make_document())

    await run_job(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
        store=FakeObjectStore(),
    )

    first, second = database.pages
    assert (first.width, first.height) == (612, 792)
    # A4 turned a quarter: 842 wide, 595 tall, and 841.89 rounds rather than
    # truncates.
    assert (second.width, second.height) == (842, 595)
    assert first.thumbnail_key == "thumb/1.webp"


async def test_progress_is_published_as_well_as_persisted(
    settings: Settings, queue: FakeQueue, stub_parse: list[dict[str, Any]]
) -> None:
    """Both, always: the publish is for a tab that is open, the row for one that is not."""
    payload = make_payload()
    database = FakeDatabase(make_document(page_count=1))

    await run_job(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
        store=FakeObjectStore(),
    )

    assert len(queue.published) == len(database.stages)
    assert all(event.documentId == payload.documentId for event in queue.published)
    # Never backwards, whatever order a caller reports stages in.
    percentages = [event.percent for event in queue.published]
    assert percentages == sorted(percentages)


async def test_no_progress_message_repeats_document_text(
    settings: Settings, queue: FakeQueue, stub_parse: list[dict[str, Any]], artifact: ParseArtifact
) -> None:
    """A document is untrusted input; a progress line is rendered on a page."""
    payload = make_payload()
    database = FakeDatabase(make_document())

    await run_job(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
        store=FakeObjectStore(),
    )

    messages = " ".join(event.message or "" for event in queue.published)
    assert "Revenue" not in messages
    assert artifact.markdown.split("\n")[0] not in messages


async def test_a_redelivered_job_does_the_work_once(
    settings: Settings, queue: FakeQueue, stub_parse: list[dict[str, Any]]
) -> None:
    """The idempotency criterion, at the level where it is decided.

    The second run must not produce a second parse result, a second set of
    pages, a second parse, or a second round of stage events — it must simply
    agree that the document is done.
    """
    payload = make_payload()
    database = FakeDatabase(make_document(page_count=2))
    store = FakeObjectStore()

    first = await run_job(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
        store=store,
    )
    stages_after_first = len(database.stages)
    first_chunks = list(database.chunks)

    second = await run_job(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
        store=store,
    )

    assert first.reused is False
    assert second.reused is True
    assert second.page_count == first.page_count
    assert len(database.parse_results) == 1
    assert len(database.pages) == 2
    # Neither expensive half ran a second time: the parse was cached, and the
    # document already had chunks.
    assert len(stub_parse) == 1
    assert second.embed is None
    assert len(database.chunks) == len(first_chunks)
    assert [row.ordinal for row in database.chunks] == sorted(
        row.ordinal for row in database.chunks
    )
    # Not one further stage event. The document is already finished, and
    # walking it back through "Indexing" would move a watching browser
    # backwards over work that did not happen.
    assert len(database.stages) == stages_after_first


async def test_a_missing_document_is_terminal(settings: Settings, queue: FakeQueue) -> None:
    payload = make_payload()
    database = FakeDatabase(None)

    with pytest.raises(JobFailure) as raised:
        await run_job(
            payload,
            database=database,
            progress=reporter(payload, queue, database),
            settings=settings,
            store=FakeObjectStore(),
        )

    assert raised.value.code is JobErrorCode.document_missing
    assert raised.value.retryable is False


async def test_another_organizations_document_is_simply_absent(
    settings: Settings, queue: FakeQueue
) -> None:
    """A payload is a message, not an authority.

    It arrives from a queue rather than from the endpoint that validated the
    upload, so a payload naming another tenant's document has to find nothing
    — the same answer an id that was never issued gets.
    """
    payload = make_payload(orgId="org_somebody_else")
    database = FakeDatabase(make_document())

    with pytest.raises(JobFailure) as raised:
        await run_job(
            payload,
            database=database,
            progress=reporter(payload, queue, database),
            settings=settings,
            store=FakeObjectStore(),
        )

    assert raised.value.code is JobErrorCode.document_missing


async def test_a_stale_content_hash_is_terminal(settings: Settings, queue: FakeQueue) -> None:
    """The bytes moved under the job; re-running it would file the parse wrongly."""
    payload = make_payload(contentHash="c" * 64)
    database = FakeDatabase(make_document())

    with pytest.raises(JobFailure) as raised:
        await run_job(
            payload,
            database=database,
            progress=reporter(payload, queue, database),
            settings=settings,
            store=FakeObjectStore(),
        )

    assert raised.value.code is JobErrorCode.content_hash_mismatch
    assert raised.value.retryable is False


async def test_a_missing_object_is_terminal(
    settings: Settings, queue: FakeQueue, tmp_path: Path
) -> None:
    """The row is there and the bytes are not. No retry will conjure them."""
    payload = make_payload()
    database = FakeDatabase(make_document())

    with pytest.raises(JobFailure) as raised:
        await run_job(
            payload,
            database=database,
            progress=reporter(payload, queue, database),
            settings=settings,
            store=FakeObjectStore(source=None),
        )

    assert raised.value.code is JobErrorCode.object_missing
    assert raised.value.retryable is False


# ── Phase 08: the index, and the cache hit that must not skip it ─────────────


async def test_a_cached_parse_still_chunks_and_embeds(
    settings: Settings, queue: FakeQueue, stub_parse: list[dict[str, Any]]
) -> None:
    """The cache-hit criterion, and the Phase 07 bug it fixes.

    A cached parse says nothing about whether *this document* has been indexed.
    In Phase 07 a hit completed the job outright, so a second organization
    uploading the same bytes got a `ready` document with an empty index — a
    document a chat would answer about out of nothing. The parse is skipped;
    the chunking is not.
    """
    payload = make_payload()
    database = FakeDatabase(make_document(page_count=2))

    # Somebody else's upload already produced the artifact, under the same
    # hashes and with no chunks for *this* document.
    database.parse_results.append(
        {
            "content_hash": payload.contentHash,
            "settings_hash": "b" * 64,
            "markdown": "# Title",
            "contents": {
                "pageCount": 2,
                "contents": [
                    {
                        "id": "el_0000",
                        "type": "paragraph",
                        "text": "Revenue grew 18% year over year.",
                        "markdown": "Revenue grew 18% year over year.",
                        "page": 1,
                        "bbox": [72, 100, 540, 140],
                        "sectionPath": [],
                    }
                ],
                "pages": [],
            },
            "page_count": 2,
        }
    )

    outcome = await run_job(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
        store=FakeObjectStore(),
    )

    assert outcome.reused is True
    # Docling never ran.
    assert stub_parse == []
    # And the document is nevertheless indexed.
    assert outcome.embed is not None
    assert len(database.chunks) > 0
    assert all(row.pages for row in database.chunks)


async def test_a_reindex_rebuilds_an_index_that_already_exists(
    settings: Settings, queue: FakeQueue, stub_parse: list[dict[str, Any]]
) -> None:
    """What an operator runs after changing the chunker or the embedding model.

    A `parse` job would skip the chunking it found already done; a `reindex`
    exists precisely to do it again — from the cached artifact, without
    re-parsing, which is what makes re-indexing a library cost embeddings
    rather than a second pass over every PDF.
    """
    payload = make_payload()
    database = FakeDatabase(make_document(page_count=2))
    store = FakeObjectStore()

    await run_job(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
        store=store,
    )
    first = list(database.chunks)
    assert first

    reindex = make_payload(type="reindex", jobId="job_reindex")
    outcome = await run_job(
        reindex,
        database=database,
        progress=reporter(reindex, queue, database),
        settings=settings,
        store=store,
    )

    assert outcome.embed is not None
    assert outcome.embed.total == len(first)
    # Still one parse, and still one chunk per ordinal.
    assert len(stub_parse) == 1
    assert len(database.chunks) == len(first)


async def test_a_chunk_embed_job_without_a_parse_fails_rather_than_parsing(
    settings: Settings, queue: FakeQueue, stub_parse: list[dict[str, Any]]
) -> None:
    """`chunk_embed` never parses; that is the whole distinction from `parse`.

    Falling back to a parse would make the job type a lie and would quietly
    spend the parse budget an operator was avoiding.
    """
    payload = make_payload(type="chunk_embed")
    database = FakeDatabase(make_document())

    with pytest.raises(JobFailure) as raised:
        await run_job(
            payload,
            database=database,
            progress=reporter(payload, queue, database),
            settings=settings,
            store=FakeObjectStore(),
        )

    assert raised.value.code is JobErrorCode.document_missing
    assert stub_parse == []


async def test_embedding_progress_is_not_clamped_by_the_thumbnail_stage(
    settings: Settings, queue: FakeQueue, stub_parse: list[dict[str, Any]]
) -> None:
    """The Phase 07 progress bug, as a regression test.

    `ProgressReporter` clamps the percentage to be monotonic. Announcing
    `persisting` (95%) during thumbnail rendering — before `chunking` (70%) and
    `embedding` (85%) had happened — pinned the bar at 95% for the whole of the
    chunking and embedding that follow, which is a spinner with extra steps.
    """
    payload = make_payload()
    database = FakeDatabase(make_document(page_count=2))

    await run_job(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
        store=FakeObjectStore(),
    )

    percentages = [percent for _stage, percent in database.stages]
    # Monotonic, and it genuinely passes through the chunking and embedding
    # bands rather than jumping to 95 and sitting there.
    assert percentages == sorted(percentages)
    assert STAGE_PERCENT[JobStage.chunking] in percentages
    assert any(
        STAGE_PERCENT[JobStage.embedding] <= percent < STAGE_PERCENT[JobStage.persisting]
        for percent in percentages
    )
    assert percentages[-1] == STAGE_PERCENT[JobStage.persisting]


async def test_the_job_result_records_what_the_index_cost(
    settings: Settings, queue: FakeQueue, stub_parse: list[dict[str, Any]]
) -> None:
    """`jobs.result` is what an operator reads to see what a job actually did."""
    payload = make_payload()
    database = FakeDatabase(make_document(page_count=2))

    outcome = await run_job(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
        store=FakeObjectStore(),
    )

    result = outcome.result()
    assert result["pages"] == 2
    assert result["chunks"] == len(database.chunks)
    # No embedding model configured in the test environment: honestly recorded
    # as nothing embedded rather than as a model that was never called.
    assert result["embedded"] == 0
    assert result["embeddingModel"] is None


async def test_a_full_ingest_completes_offline_against_only_ollama(
    queue: FakeQueue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The offline criterion, end to end, with the provider faked and nothing else.

    `OFFLINE_MODE=true` plus a local Ollama is the configuration this project is
    installed for, so the whole pipeline is run under it: the settings pass the
    boot check, the router resolves to a local endpoint, and the chunks come out
    with vectors of the width the column is declared at.

    Only the HTTP call is faked. Faking the router instead would leave the one
    thing worth proving — that role resolution reaches a local endpoint under
    offline mode — untested.
    """
    offline = Settings(
        _env_file=None,
        offline_mode=True,
        llm_provider="ollama",
        embedding_model="ollama/bge-m3",
        ollama_base_url="http://ollama:11434",
        embedding_batch_size=2,
        worker_parse_threads=4,
        **BASE_ENV,
    )

    # A document with enough prose to need several batches, so that "progress
    # increments" is a claim this test can actually check.
    monkeypatch.setattr("konusbitr_worker.pipeline.parse_document", _stub_returning(_wordy(24)))

    calls: list[dict[str, Any]] = []

    async def fake_embedding(**kwargs: Any) -> Any:
        calls.append(kwargs)
        count = len(kwargs["input"])
        return SimpleNamespace(
            data=[
                {"index": index, "embedding": [0.01] * offline.embedding_dimensions}
                for index in range(count)
            ],
            usage=SimpleNamespace(prompt_tokens=11 * count),
        )

    monkeypatch.setattr("litellm.aembedding", fake_embedding)

    payload = make_payload()
    database = FakeDatabase(make_document(page_count=2))

    outcome = await run_job(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=offline,
        store=FakeObjectStore(),
    )

    assert outcome.embed is not None
    assert outcome.embed.embedded == outcome.embed.total > 0
    assert outcome.embed.model == "ollama/bge-m3"

    # Every call went to the local endpoint, and none of them asked OpenAI for a
    # `dimensions` a local server has never heard of.
    assert calls
    for call in calls:
        assert call["api_base"] == "http://ollama:11434"
        assert "dimensions" not in call
        assert len(call["input"]) <= offline.embedding_batch_size

    assert all(
        row.embedding is not None and len(row.embedding) == offline.embedding_dimensions
        for row in database.chunks
    )
    assert database.embedding_recorded == [("ollama/bge-m3", offline.embedding_dimensions)]

    # And the bar moved through the embedding band per batch rather than
    # jumping from 85 to 95.
    embedding_percentages = [
        percent for stage, percent in database.stages if stage is JobStage.embedding
    ]
    assert len(embedding_percentages) > 2
    assert embedding_percentages == sorted(embedding_percentages)


async def test_a_configured_provider_that_fails_is_a_job_failure(
    queue: FakeQueue, stub_parse: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The distinction that matters: unconfigured degrades, configured fails.

    A stack with no embedding model stores chunks without vectors and says so.
    A stack that names a model and cannot reach it must *not* quietly do the
    same thing — that would leave a document looking indexed when it is not.
    """
    configured = Settings(
        _env_file=None,
        llm_provider="ollama",
        embedding_model="ollama/bge-m3",
        model_max_retries=1,
        worker_parse_threads=4,
        **BASE_ENV,
    )

    async def unreachable(**_kwargs: Any) -> Any:
        raise ConnectionError("no route to host")

    monkeypatch.setattr("litellm.aembedding", unreachable)

    payload = make_payload()
    database = FakeDatabase(make_document(page_count=2))

    with pytest.raises(ModelCallError):
        await run_job(
            payload,
            database=database,
            progress=reporter(payload, queue, database),
            settings=configured,
            store=FakeObjectStore(),
        )

    # Nothing was claimed about an index that does not exist.
    assert database.embedding_recorded == []


def _wordy(paragraphs: int) -> ParseArtifact:
    """An artifact with enough prose in it to produce several chunks."""
    text = " ".join(f"item{index} counts." for index in range(220))
    return ParseArtifact(
        markdown="# Title",
        page_count=paragraphs,
        contents=[
            ParsedElement(
                id=f"el_{index:04d}",
                type=ElementType.paragraph,
                text=text,
                markdown=text,
                page=1 + index,
                bbox=BBox(72.0, 100.0, 540.0, 700.0),
            )
            for index in range(paragraphs)
        ],
        pages=[
            ParsedPage(page_no=1 + index, width=612.0, height=792.0) for index in range(paragraphs)
        ],
    )


def _stub_returning(artifact: ParseArtifact):
    """A `parse_document` stand-in that walks the stages and returns `artifact`."""

    async def fake_parse(**kwargs: Any) -> ParseArtifact:
        on_stage = kwargs.get("on_stage")
        if on_stage is not None:
            for stage in (JobStage.fetching, JobStage.validating, JobStage.parsing):
                await on_stage(stage)
        return artifact

    return fake_parse
