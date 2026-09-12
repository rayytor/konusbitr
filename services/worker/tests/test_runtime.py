"""What the loop does with the outcome of one delivery.

Every branch here ends in an acknowledgement, and that is the invariant worth
holding onto: success, permanent failure and "parked for a retry" are all
conclusions, and an entry that has reached one must never be redelivered. The
only thing that stays unacknowledged is a job the worker died in the middle
of, which is precisely what a restart is supposed to find.
"""

from __future__ import annotations

import asyncio
from typing import Any, cast

import pytest

from konusbitr_worker.contracts import JobErrorCode, JobStage
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.queue import Delivery, UndecodableEntry
from konusbitr_worker.runtime import WorkerRuntime
from konusbitr_worker.settings import Settings
from tests.factories import (
    FakeDatabase,
    FakeObjectStore,
    FakeQueue,
    make_document,
    make_payload,
)

pytestmark = pytest.mark.asyncio


def runtime(
    settings: Settings,
    queue: FakeQueue,
    database: FakeDatabase,
    store: Any = None,
) -> WorkerRuntime:
    return WorkerRuntime(
        settings=settings,
        queue=cast(Any, queue),
        database=cast(Any, database),
        store=store or FakeObjectStore(),
    )


def delivery(payload: Any = None, entry_id: str = "1-0") -> Delivery:
    resolved = payload or make_payload()
    return Delivery(entry_id, resolved, resolved.model_dump_json())


async def test_a_successful_job_completes_and_is_acknowledged(
    settings: Settings, queue: FakeQueue, stub_parse: list[dict[str, Any]]
) -> None:
    database = FakeDatabase(make_document(page_count=2))
    entry = delivery()

    await runtime(settings, queue, database)._run(entry)

    assert database.started == [(entry.payload.jobId, 1)]
    assert len(database.completed) == 1
    assert database.completed[0]["page_count"] == 2
    assert queue.acked == [entry.entry_id]
    assert queue.dead == []
    assert queue.retries == []
    assert queue.published[-1].stage is JobStage.ready


async def test_redelivery_after_a_crash_completes_exactly_once(
    settings: Settings, queue: FakeQueue, stub_parse: list[dict[str, Any]]
) -> None:
    """The acceptance criterion, at the level the loop controls.

    The queue can only promise at-least-once. "Exactly once" is what the
    writes underneath make of that: a second delivery of the same entry adds
    no parse result and no pages, and still ends with the document ready.
    """
    database = FakeDatabase(make_document(page_count=2))
    entry = delivery()
    loop = runtime(settings, queue, database)

    await loop._run(entry)
    await loop._run(entry)

    assert len(database.parse_results) == 1
    assert len(database.pages) == 2
    assert len(database.completed) == 2  # idempotent: the same row, written twice
    assert queue.acked == [entry.entry_id, entry.entry_id]
    assert database.completed[-1]["page_count"] == 2


async def test_a_terminal_failure_is_dead_lettered_without_spending_retries(
    settings: Settings, queue: FakeQueue
) -> None:
    """A corrupt document does not improve on the third attempt.

    Burning the budget on it would delay every other job in the queue to reach
    a conclusion that was available immediately.
    """
    database = FakeDatabase(None)  # the document is gone: terminal
    entry = delivery()

    await runtime(settings, queue, database)._run(entry)

    assert queue.retries == []
    assert len(queue.dead) == 1
    assert queue.dead[0]["error_code"] is JobErrorCode.document_missing
    assert queue.dead[0]["attempts"] == 1
    assert database.failures[0]["terminal"] is True
    assert queue.acked == [entry.entry_id]
    assert queue.published[-1].stage is JobStage.failed
    assert queue.published[-1].errorCode is JobErrorCode.document_missing


async def test_a_retryable_failure_is_parked_with_exponential_backoff(
    settings: Settings, queue: FakeQueue, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = FakeDatabase(make_document())
    monkeypatch.setattr(
        "konusbitr_worker.runtime.run_parse",
        _raising(JobFailure(JobErrorCode.storage_unavailable, "MinIO is not answering")),
    )

    loop = runtime(settings, queue, database)
    await loop._run(delivery(make_payload(attempt=1)))
    await loop._run(delivery(make_payload(attempt=2), entry_id="2-0"))

    assert [delay for _payload, delay in queue.retries] == [1.0, 2.0]
    assert [payload.attempt for payload, _delay in queue.retries] == [2, 3]
    assert queue.dead == []
    # The document is not flipped to `failed` between attempts: a row that
    # dies and revives a few seconds later reads as a bug even when the retry
    # succeeds.
    assert all(failure["terminal"] is False for failure in database.failures)


async def test_the_last_attempt_dead_letters_instead_of_retrying_again(
    settings: Settings, queue: FakeQueue, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = FakeDatabase(make_document())
    monkeypatch.setattr(
        "konusbitr_worker.runtime.run_parse",
        _raising(JobFailure(JobErrorCode.model_timeout, "the model did not answer")),
    )

    # `worker_max_attempts` is 3, so attempt 3 has nothing left.
    await runtime(settings, queue, database)._run(delivery(make_payload(attempt=3)))

    assert queue.retries == []
    assert len(queue.dead) == 1
    assert queue.dead[0]["attempts"] == 3
    assert database.failures[0]["terminal"] is True


async def test_an_unknown_job_type_is_terminal(settings: Settings, queue: FakeQueue) -> None:
    """Declared in the contract, unimplemented here.

    Retrying three times before dead-lettering would only delay the same
    answer, so the handler refuses immediately.
    """
    database = FakeDatabase(make_document())

    await runtime(settings, queue, database)._run(delivery(make_payload(type="reindex")))

    assert queue.retries == []
    assert queue.dead[0]["error_code"] is JobErrorCode.unknown_job_type


async def test_a_job_that_overruns_its_timeout_is_retried(
    settings: Settings, queue: FakeQueue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A wedged parse must not hold a slot forever.

    Retryable, not terminal: a job that ran long is usually a machine under
    load or a model that stalled, and the next attempt often succeeds.
    """

    async def never_finishes(*_args: Any, **_kwargs: Any) -> None:
        await asyncio.sleep(30)

    monkeypatch.setattr("konusbitr_worker.runtime.run_parse", never_finishes)

    database = FakeDatabase(make_document())
    loop = runtime(settings.model_copy(update={"worker_job_timeout_seconds": 1}), queue, database)

    await loop._run(delivery())

    assert len(queue.retries) == 1
    assert database.failures[0]["error_code"] == JobErrorCode.timeout.value
    assert database.failures[0]["terminal"] is False


async def test_an_undecodable_entry_is_dead_lettered_and_acknowledged(
    settings: Settings, queue: FakeQueue
) -> None:
    """The criterion that a bad payload is not retried forever.

    There is nothing to retry it *with*: it failed schema validation, so it
    will fail identically every time, and a queue that keeps redelivering one
    turns a single bad message into an outage.
    """
    database = FakeDatabase(make_document())
    loop = runtime(settings, queue, database)
    await loop._slots.acquire()

    await loop._dispatch(
        UndecodableEntry(
            "9-0",
            '{"v": 1, "jobId": "job_1"}',
            JobFailure(JobErrorCode.invalid_payload, "storageKey: Field required"),
        )
    )

    assert len(queue.dead) == 1
    assert queue.dead[0]["error_code"] is JobErrorCode.invalid_payload
    assert queue.dead[0]["raw"] == '{"v": 1, "jobId": "job_1"}'
    assert queue.acked == ["9-0"]
    # The slot is handed back, or the loop would narrow by one per bad message
    # until it stopped reading altogether.
    assert loop._slots._value == settings.worker_concurrency


def _raising(error: BaseException) -> Any:
    """A `run_parse` stand-in that always fails the same way."""

    async def raiser(*_args: Any, **_kwargs: Any) -> None:
        raise error

    return raiser
