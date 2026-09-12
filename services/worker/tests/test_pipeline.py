"""The stub pipeline, and the parts of it Phase 07 keeps.

The sleeps are not interesting. What is: the document lookup is org-scoped, the
content hash is re-checked against the row rather than trusted, and a parse
that already exists short-circuits instead of being redone. Those three survive
the stub and are what make a re-delivered job harmless.
"""

from __future__ import annotations

from typing import Any

import pytest

from konusbitr_worker.contracts import JobErrorCode, JobStage
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.pipeline import run_parse
from konusbitr_worker.progress import ProgressReporter
from konusbitr_worker.settings import Settings
from tests.factories import FakeDatabase, FakeQueue, make_document, make_payload

pytestmark = pytest.mark.asyncio


def reporter(payload: Any, queue: Any, database: Any) -> ProgressReporter:
    return ProgressReporter(payload=payload, queue=queue, database=database)


async def test_a_parse_walks_the_stages_and_writes_its_result(
    settings: Settings, queue: FakeQueue
) -> None:
    payload = make_payload()
    database = FakeDatabase(make_document(page_count=3))

    outcome = await run_parse(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
    )

    assert outcome.page_count == 3
    assert outcome.reused is False
    assert len(database.parse_results) == 1
    assert database.parse_results[0]["content_hash"] == payload.contentHash
    # One page row per page, in the one coordinate convention.
    assert [page_no for _id, page_no, _w, _h in database.pages] == [1, 2, 3]

    stages = [stage for stage, _percent in database.stages]
    assert stages == [
        JobStage.fetching,
        JobStage.validating,
        JobStage.parsing,
        JobStage.ocr,
        JobStage.chunking,
        JobStage.embedding,
        JobStage.persisting,
    ]


async def test_progress_is_published_as_well_as_persisted(
    settings: Settings, queue: FakeQueue
) -> None:
    """Both, always: the publish is for a tab that is open, the row for one that is not."""
    payload = make_payload()
    database = FakeDatabase(make_document(page_count=1))

    await run_parse(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
    )

    assert len(queue.published) == len(database.stages)
    assert all(event.documentId == payload.documentId for event in queue.published)
    # Never backwards, whatever order a caller reports stages in.
    percentages = [event.percent for event in queue.published]
    assert percentages == sorted(percentages)


async def test_the_markdown_cannot_be_mistaken_for_a_real_parse(
    settings: Settings, queue: FakeQueue
) -> None:
    payload = make_payload()
    database = FakeDatabase(make_document(page_count=1))

    await run_parse(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
    )

    markdown = database.parse_results[0]["markdown"]
    assert "Placeholder" in markdown
    assert "Phase 07" in markdown


async def test_a_redelivered_job_does_the_work_once(settings: Settings, queue: FakeQueue) -> None:
    """The idempotency criterion, at the level where it is decided.

    The second run must not produce a second parse result, a second set of
    pages, or a second round of stage events — it must simply agree that the
    document is done.
    """
    payload = make_payload()
    database = FakeDatabase(make_document(page_count=2))

    first = await run_parse(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
    )
    stages_after_first = len(database.stages)

    second = await run_parse(
        payload,
        database=database,
        progress=reporter(payload, queue, database),
        settings=settings,
    )

    assert first.reused is False
    assert second.reused is True
    assert second.page_count == first.page_count
    assert len(database.parse_results) == 1
    assert len(database.pages) == 2
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
        )

    assert raised.value.code is JobErrorCode.content_hash_mismatch
    assert raised.value.retryable is False
