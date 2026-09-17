"""A long ingest, interrupted: what survives, what resumes, what stops.

Four claims of Phase 12.4, exercised through the real pipeline and the real
runtime with only the parse itself replaced by a double. That split is the
point: the parse is covered against real PDFs in `test_parse_fixtures.py` and
`test_ocr_fixtures.py`, and what these tests are about is the *bookkeeping
around* it — which pages a resumed run re-reads, what a cancellation costs, and
whether a half-finished parse can be mistaken for a cache entry.

The double is a parse that reports page batches exactly as the real one does,
so the pipeline's commit callback runs for real. Everything it asserts about —
checkpoints, chunk ordinals, page counters, partial readiness — is written by
production code.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from konusbitr_worker.contracts import JOB_CHECKPOINT_VERSION, JobStage
from konusbitr_worker.errors import JobCancelled
from konusbitr_worker.parse import BatchOutcome
from konusbitr_worker.parse.artifact import (
    ElementType,
    ParseArtifact,
    ParsedElement,
    ParsedPage,
)
from konusbitr_worker.parse.batching import page_batches
from konusbitr_worker.parse.geometry import BBox
from konusbitr_worker.pipeline import run_job
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

#: Small enough that a short fixture still spans several batches, so the tests
#: exercise the batched path without pretending to read 900 pages.
BATCH = 4


def element(page: int) -> ParsedElement:
    text = " ".join(f"page{page}word{index}" for index in range(120))
    return ParsedElement(
        id="el_0000",
        type=ElementType.paragraph,
        text=text,
        markdown=text,
        page=page,
        bbox=BBox(72.0, 100.0, 540.0, 700.0),
    )


class StubParse:
    """A `parse_document` stand-in that walks page batches like the real one.

    It exists so these tests can interrupt a parse deterministically. `stop_at`
    raises after the batch ending on that page, which is a crash; `cancel_at`
    makes the cancellation predicate true at that point, which is a person
    pressing the button. Both are things that are hard to schedule reliably
    against a real parser and trivial against this.
    """

    def __init__(
        self,
        *,
        page_count: int,
        stop_at: int | None = None,
        cancel_at: int | None = None,
    ) -> None:
        self.page_count = page_count
        self.stop_at = stop_at
        self.cancel_at = cancel_at
        #: Every page this instance actually read, in order. The whole point of
        #: a resume test is what is *not* in here.
        self.read: list[int] = []

    async def __call__(self, **kwargs: Any) -> ParseArtifact:
        resume = kwargs.get("resume")
        on_batch = kwargs.get("on_batch")
        should_cancel = kwargs.get("should_cancel")
        batch_size = kwargs.get("batch_size") or BATCH

        elements: list[ParsedElement] = list(resume.elements) if resume else []
        pages: list[ParsedPage] = list(resume.pages) if resume else []
        start_after = resume.last_processed_page if resume else 0
        chunks_written = resume.chunks_written if resume else 0

        for batch in page_batches(
            page_count=self.page_count,
            scanned_pages=set(),
            batch_size=batch_size,
            start_after=start_after,
        ):
            if should_cancel is not None and should_cancel():
                raise JobCancelled(pages_done=start_after, pages_total=self.page_count)

            committed: list[ParsedElement] = []
            for page_no in batch.pages:
                self.read.append(page_no)
                item = ParsedElement(
                    id=f"el_{len(elements):04d}",
                    type=element(page_no).type,
                    text=element(page_no).text,
                    markdown=element(page_no).markdown,
                    page=page_no,
                    bbox=element(page_no).bbox,
                )
                elements.append(item)
                committed.append(item)
                pages.append(ParsedPage(page_no=page_no, width=612.0, height=792.0))

            artifact = ParseArtifact(
                markdown="# Doc",
                page_count=self.page_count,
                contents=list(elements),
                pages=list(pages),
            )

            if on_batch is not None:
                chunks_written = await on_batch(
                    BatchOutcome(
                        first_page=batch.first_page,
                        last_page=batch.last_page,
                        elements=committed,
                        artifact=artifact,
                        pages_done=batch.last_page,
                        page_count=self.page_count,
                        chunks_written=chunks_written,
                    )
                )

            start_after = batch.last_page

            if self.cancel_at is not None and batch.last_page >= self.cancel_at:
                # Modelled the way the real loop behaves: the flag is noticed at
                # the *next* boundary, so the batch in flight finishes first.
                self.cancel_at = None
                raise JobCancelled(pages_done=batch.last_page, pages_total=self.page_count)

            if self.stop_at is not None and batch.last_page >= self.stop_at:
                raise RuntimeError("the worker was killed")

        return ParseArtifact(
            markdown="# Doc",
            page_count=self.page_count,
            contents=list(elements),
            pages=list(pages),
        )


def batched_settings(**overrides: Any) -> Settings:
    from tests.factories import BASE_ENV

    return Settings(_env_file=None, worker_page_batch_size=BATCH, **BASE_ENV, **overrides)


async def ingest(
    *,
    parse: StubParse,
    database: FakeDatabase,
    queue: FakeQueue,
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
    cancelled: Any = None,
) -> Any:
    monkeypatch.setattr("konusbitr_worker.pipeline.parse_document", parse)
    payload = make_payload()
    return await run_job(
        payload,
        database=database,
        progress=ProgressReporter(payload=payload, queue=queue, database=database),
        settings=settings,
        store=FakeObjectStore(),
        cancelled=cancelled,
    )


# ── Checkpointing and resumption ─────────────────────────────────────────────


async def test_a_crashed_job_resumes_at_the_page_after_the_checkpoint(
    queue: FakeQueue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The headline criterion: kill it in the middle, restart, read the rest.

    The assertion that matters is not that the document finishes — a job that
    started over would also finish. It is that the second run *never opens* a
    page the first one committed. On a 900-page filing parsed with captions,
    re-reading the first 450 is not slow, it is the reader paying twice.
    """
    settings = batched_settings()
    database = FakeDatabase(make_document(page_count=12))

    crashed = StubParse(page_count=12, stop_at=8)
    with pytest.raises(RuntimeError):
        await ingest(
            parse=crashed,
            database=database,
            queue=queue,
            settings=settings,
            monkeypatch=monkeypatch,
        )
    assert crashed.read == list(range(1, 9))

    # The row the crash left behind is a parse in progress, and says so.
    [row] = database.parse_results
    assert row["checkpoint"]["lastProcessedPage"] == 8
    assert row["checkpoint"]["version"] == JOB_CHECKPOINT_VERSION

    # And the job row carries the same thing, for whoever is reading the job
    # table rather than the cache. Nothing branches on this copy.
    assert database.job_checkpoints[-1][1]["lastProcessedPage"] == 8

    resumed = StubParse(page_count=12)
    outcome = await ingest(
        parse=resumed, database=database, queue=queue, settings=settings, monkeypatch=monkeypatch
    )

    assert resumed.read == [9, 10, 11, 12]
    assert outcome.page_count == 12
    # And the finished row is a cache entry again, which is what `checkpoint IS
    # NULL` means everywhere it is read. The mirror is cleared with it, so a
    # finished job does not look half-done in the job table.
    assert database.parse_results[0]["checkpoint"] is None
    assert database.job_checkpoints[-1][1] is None


async def test_a_half_finished_parse_is_never_served_as_a_cache_hit(
    queue: FakeQueue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The docId cache invariant, under interruption.

    A row carrying a checkpoint holds the pages read so far and is missing the
    rest. Handing it to a second upload would return `ready` for a document
    that stops halfway — the silent emptiness the pipeline's refusals exist to
    prevent, arrived at through the cache instead of through the parser.
    """
    settings = batched_settings()
    database = FakeDatabase(make_document(page_count=12))

    with pytest.raises(RuntimeError):
        await ingest(
            parse=StubParse(page_count=12, stop_at=4),
            database=database,
            queue=queue,
            settings=settings,
            monkeypatch=monkeypatch,
        )

    document = await database.document("doc_test", "org_test")
    assert document is not None
    assert await database.parse_artifact(document.content_hash, document.settings_hash) is None
    assert await database.resume_point(document.content_hash, document.settings_hash) is not None


async def test_chunk_ordinals_stay_contiguous_across_a_resume(
    queue: FakeQueue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ordinals are the upsert key, and the final prune deletes past the count.

    A resumed batch that restarted its numbering would overwrite the chunks the
    first run wrote and then, at the prune, delete the document's tail — which
    is a document that looks indexed and answers out of a third of itself.
    """
    settings = batched_settings()
    database = FakeDatabase(make_document(page_count=12))

    with pytest.raises(RuntimeError):
        await ingest(
            parse=StubParse(page_count=12, stop_at=8),
            database=database,
            queue=queue,
            settings=settings,
            monkeypatch=monkeypatch,
        )
    after_crash = len(database.chunks)
    assert after_crash > 0

    await ingest(
        parse=StubParse(page_count=12),
        database=database,
        queue=queue,
        settings=settings,
        monkeypatch=monkeypatch,
    )

    ordinals = sorted(row.ordinal for row in database.chunks)
    assert ordinals == list(range(len(ordinals)))
    assert len(ordinals) > after_crash


# ── Partial readiness ────────────────────────────────────────────────────────


async def test_the_document_becomes_answerable_before_it_is_finished(
    queue: FakeQueue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Partial readiness, as the two writes a reader's experience rests on.

    `pages_ready` is what the banner counts and `partially_ready` is what
    unlocks the viewer, and both have to happen at the *first* batch rather
    than at the end — the whole feature is the fourteen minutes between them on
    a long document.
    """
    settings = batched_settings()
    database = FakeDatabase(make_document(page_count=12))

    await ingest(
        parse=StubParse(page_count=12),
        database=database,
        queue=queue,
        settings=settings,
        monkeypatch=monkeypatch,
    )

    assert database.page_counts[0] == (BATCH, 12)
    assert database.page_counts[-1] == (12, 12)
    # Announced on every batch but the last: a reader told a document is partly
    # available a moment before being told it is finished has learned nothing.
    assert len(database.partially_ready) == 2
    assert database.chunks


async def test_progress_frames_carry_the_page_counts(
    queue: FakeQueue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ "142 of 900" is the number a person can estimate from; 23% is not."""
    settings = batched_settings()
    database = FakeDatabase(make_document(page_count=12))

    await ingest(
        parse=StubParse(page_count=12),
        database=database,
        queue=queue,
        settings=settings,
        monkeypatch=monkeypatch,
    )

    counted = [frame for frame in queue.published if frame.pagesTotal]
    assert counted
    assert [frame.pagesReady for frame in counted][-1] == 12
    assert all(frame.pagesTotal == 12 for frame in counted)

    # The bar moves forwards across the batches and never reaches `persisting`
    # early — a bar that hits 95% twice tells a watcher nothing the first time.
    percentages = [frame.percent for frame in counted]
    assert percentages == sorted(percentages)


# ── Cancellation ─────────────────────────────────────────────────────────────


async def test_a_cancelled_job_keeps_what_it_had_already_indexed(
    queue: FakeQueue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A cancelled document is a short document, not a broken one.

    Every page committed before the stop was committed properly — elements,
    page rows, chunks — so the honest outcome is a document that can be read up
    to where it got to. That is the whole reason the status is `cancelled`
    rather than `failed`.
    """
    settings = batched_settings()
    database = FakeDatabase(make_document(page_count=12))

    with pytest.raises(JobCancelled) as raised:
        await ingest(
            parse=StubParse(page_count=12, cancel_at=BATCH),
            database=database,
            queue=queue,
            settings=settings,
            monkeypatch=monkeypatch,
        )

    assert raised.value.pages_done == BATCH
    assert raised.value.pages_total == 12
    assert "4 of 12 pages" in raised.value.message
    assert database.chunks
    assert database.page_counts[-1] == (BATCH, 12)


async def test_the_runtime_concludes_a_cancellation_without_a_retry(
    queue: FakeQueue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The conclusion, from the runtime's side.

    Every branch that handles a *failure* does something a cancellation must
    not: it spends a retry, it writes a dead letter, it marks a document failed
    in red and files a line in the operator's failed-jobs view. A person
    stopping their own upload is none of those.
    """
    from konusbitr_worker.queue import Delivery
    from konusbitr_worker.runtime import WorkerRuntime

    settings = batched_settings()
    database = FakeDatabase(make_document(page_count=12))
    payload = make_payload()

    monkeypatch.setattr(
        "konusbitr_worker.pipeline.parse_document", StubParse(page_count=12, cancel_at=BATCH)
    )

    runtime = WorkerRuntime(settings=settings, queue=queue, database=database)
    await queue.request_cancel(payload.jobId)
    await runtime._run_inner(Delivery(entry_id="1-0", payload=payload, raw="{}"))

    assert database.cancellations and database.cancellations[0]["job_id"] == payload.jobId
    assert queue.acked == ["1-0"]
    assert queue.retries == []
    assert queue.dead == []
    assert database.failures == []
    # The flag is consumed, so the retry a reader might start a second later is
    # not cancelled the instant it begins.
    assert queue.cleared == [payload.jobId]
    assert queue.published[-1].stage is JobStage.cancelled


async def test_the_cancellation_flag_is_noticed_without_waiting_for_the_batch(
    queue: FakeQueue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The two-second budget, as the mechanism that makes it reachable.

    The predicate handed to the parse has to be answerable *synchronously*,
    from inside the worker threads where recognition happens — so the watcher
    polls Redis on the loop and caches the answer. This checks the cache is
    live rather than read once at the start: a flag set while the job is
    running must become visible without the job asking Redis itself.
    """
    from konusbitr_worker.runtime import _CancelWatcher

    monkeypatch.setattr("konusbitr_worker.runtime.CANCEL_POLL_SECONDS", 0.01)

    async with _CancelWatcher(queue=queue, job_id="job_test") as watcher:
        assert watcher.requested() is False
        await queue.request_cancel("job_test")
        for _ in range(100):
            if watcher.requested():
                break
            await asyncio.sleep(0.01)
        assert watcher.requested() is True


async def test_an_unreachable_redis_is_not_a_cancellation(
    queue: FakeQueue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Guessing wrong in this direction stops a document for no visible reason.

    A Redis blip while a job is running is an infrastructure hiccup, not a
    person pressing a button — so the flag stays as it was and the job carries
    on. The opposite default would abandon a fourteen-minute ingest over a
    dropped connection.
    """
    from konusbitr_worker.queue import JobQueue

    class Unreachable:
        async def exists(self, _key: str) -> int:
            raise ConnectionError("no route to host")

    assert await JobQueue(Unreachable(), consumer="test").is_cancelled("job_test") is False
