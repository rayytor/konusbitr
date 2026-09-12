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
from typing import Any

import pytest

from konusbitr_worker.contracts import JobErrorCode, JobStage
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.parse.artifact import ParseArtifact
from konusbitr_worker.pipeline import run_parse
from konusbitr_worker.progress import ProgressReporter
from konusbitr_worker.settings import Settings
from tests.factories import (
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

    outcome = await run_parse(
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

    await run_parse(
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

    await run_parse(
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

    await run_parse(
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

    await run_parse(
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

    first = await run_parse(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
        store=store,
    )
    stages_after_first = len(database.stages)

    second = await run_parse(
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
    # The expensive half never ran a second time.
    assert len(stub_parse) == 1
    # Not one further stage event. The document is already finished, and
    # walking it back through "Indexing" would move a watching browser
    # backwards over work that did not happen.
    assert len(database.stages) == stages_after_first


async def test_a_missing_document_is_terminal(settings: Settings, queue: FakeQueue) -> None:
    payload = make_payload()
    database = FakeDatabase(None)

    with pytest.raises(JobFailure) as raised:
        await run_parse(
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
        await run_parse(
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
        await run_parse(
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
        await run_parse(
            payload,
            database=database,
            progress=reporter(payload, queue, database),
            settings=settings,
            store=FakeObjectStore(source=None),
        )

    assert raised.value.code is JobErrorCode.object_missing
    assert raised.value.retryable is False
