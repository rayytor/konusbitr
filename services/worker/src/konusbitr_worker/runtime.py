"""The job loop: read, run, conclude, acknowledge.

Three invariants hold this together, and each is worth stating because each is
easy to lose in a refactor.

**An entry is acknowledged exactly once, and only once it has a conclusion.**
Success, permanent failure, and "parked for a retry" are all conclusions;
"crashed halfway" is not, which is why the acknowledgement is the last thing
that happens rather than the first.

**Re-delivery is free.** Every write the pipeline makes is an upsert, and each
expensive stage short-circuits when what it was about to produce already
exists: the parse when the docId cache holds it, the index when the document
already has chunks. So a worker killed mid-job, restarted, and handed the same
entry back finishes it without doubling anything — which is what "exactly once"
can mean on a transport that only promises "at least once".

**A terminal failure never burns a retry.** The classification, not the number
of attempts, decides: a corrupt PDF is dead-lettered on attempt one, while a
Redis blip gets the full budget with exponential backoff in between.

Phase 12.4 adds a fourth, which is a conclusion rather than an invariant: **a
cancellation is not a failure.** It spends no retry, writes no dead letter, and
leaves nothing in the operator's failed-jobs view — a person stopping their own
upload is not an incident. What it does leave is everything the job had already
committed, because a batched parse commits as it goes: a cancelled document is
a short document rather than a broken one.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable
from typing import Any

from konusbitr_worker.contracts import JobErrorCode, JobPayload, JobStage, JobType
from konusbitr_worker.db import Database
from konusbitr_worker.errors import JobCancelled, JobFailure, classify_exception
from konusbitr_worker.log import get_logger, job_context
from konusbitr_worker.parse.storage import ObjectStore
from konusbitr_worker.pipeline import JobOutcome, run_job
from konusbitr_worker.progress import ProgressReporter
from konusbitr_worker.queue import Delivery, JobQueue, UndecodableEntry
from konusbitr_worker.scratch import sweep_orphans
from konusbitr_worker.settings import Settings

__all__ = ["WorkerRuntime"]

logger = get_logger("konusbitr.worker.runtime")

#: How long a blocking read waits before looping, so shutdown stays responsive.
READ_BLOCK_MS = 2_000

#: How often the janitor promotes due retries and reclaims abandoned entries.
JANITOR_INTERVAL_SECONDS = 1.0

#: How often a running job re-reads its cancellation flag.
#:
#: The phase asks for a cancellation to take effect within two seconds, and the
#: budget is spent in two places: this poll, and the page the job is in the
#: middle of when it notices. Half a second leaves the rest of the budget for
#: the page, and costs one `EXISTS` per running job per half second — which on
#: a worker with `WORKER_CONCURRENCY=2` is four Redis round trips a second.
CANCEL_POLL_SECONDS = 0.5


class WorkerRuntime:
    """Owns the consumer loop and everything it needs."""

    def __init__(
        self,
        *,
        settings: Settings,
        queue: JobQueue,
        database: Database,
        store: ObjectStore | None = None,
    ) -> None:
        self._settings = settings
        self._queue = queue
        self._database = database
        self._store = store
        self._stopping = asyncio.Event()
        self._slots = asyncio.Semaphore(settings.worker_concurrency)
        self._in_flight: set[asyncio.Task[None]] = set()
        self._tasks: list[asyncio.Task[None]] = []
        self._processed = 0

    @property
    def processed(self) -> int:
        """Jobs concluded since start. Reported by ``/health``."""
        return self._processed

    @property
    def in_flight(self) -> int:
        return len(self._in_flight)

    @property
    def running(self) -> bool:
        return bool(self._tasks) and not self._stopping.is_set()

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        # Before anything is read. A worker that was killed mid-parse left its
        # spilled page bitmaps behind, and at startup — and only at startup —
        # every directory under the scratch root belongs to a run that is over.
        sweep_orphans()
        await self._queue.ensure_group()
        await self._recover_own_pending()
        self._tasks = [
            asyncio.create_task(self._consume(), name="konusbitr-consume"),
            asyncio.create_task(self._janitor(), name="konusbitr-janitor"),
        ]
        logger.info(
            "job loop started",
            extra={
                "consumer": self._queue.consumer,
                "concurrency": self._settings.worker_concurrency,
            },
        )

    async def stop(self) -> None:
        """Stop reading, let what is in flight finish, then return.

        In-flight jobs are awaited rather than cancelled: a container gets its
        stop grace period either way, and a job that completes is one nobody
        has to redeliver. Anything still running when the grace period expires
        is left in the pending-entries list, which is exactly where the
        restarted worker will look for it.
        """
        self._stopping.set()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks = []

        if self._in_flight:
            logger.info("waiting for in-flight jobs", extra={"count": len(self._in_flight)})
            await asyncio.gather(*self._in_flight, return_exceptions=True)

        logger.info("job loop stopped", extra={"processed": self._processed})

    # ── Loops ────────────────────────────────────────────────────────────────

    async def _recover_own_pending(self) -> None:
        """Pick up whatever this consumer was holding when it last died."""
        pending = await self._queue.read_own_pending(count=self._settings.worker_concurrency * 4)
        if not pending:
            return

        logger.info("recovering unacknowledged deliveries", extra={"count": len(pending)})
        for entry in pending:
            await self._slots.acquire()
            await self._dispatch(entry)

    async def _consume(self) -> None:
        """Read one entry at a time, and only while there is a slot free for it.

        The semaphore is acquired *before* the read and handed to whatever the
        read produced — `_dispatch` owns it from that point and releases it
        when the job concludes. Acquiring first is what makes
        `WORKER_CONCURRENCY` mean something: a worker that read eagerly and
        queued internally would hold deliveries it is not working on, and
        those are invisible to every other replica.
        """
        while not self._stopping.is_set():
            await self._slots.acquire()
            entries: list[Delivery | UndecodableEntry] = []
            try:
                entries = await self._queue.read(count=1, block_ms=READ_BLOCK_MS)
            except asyncio.CancelledError:
                self._slots.release()
                raise
            except Exception:
                # A failed read is Redis being unavailable, not a bad job.
                # Logging and pausing beats a hot loop against a dead server.
                logger.exception("could not read from the job stream")
                self._slots.release()
                await asyncio.sleep(1.0)
                continue

            if not entries:
                self._slots.release()
                continue

            first, rest = entries[0], entries[1:]
            await self._dispatch(first)
            for entry in rest:  # `count=1` makes this empty; belt and braces.
                await self._slots.acquire()
                await self._dispatch(entry)

    async def _janitor(self) -> None:
        """Promote due retries, and adopt entries a dead replica left behind."""
        # Twice the job timeout: anything idle for longer than a job is allowed
        # to take is not slow, it is gone.
        min_idle_ms = self._settings.worker_job_timeout_seconds * 2 * 1000

        while not self._stopping.is_set():
            try:
                await self._queue.promote_due_retries()
                for entry in await self._queue.claim_abandoned(
                    min_idle_ms=min_idle_ms, count=self._settings.worker_concurrency
                ):
                    logger.info("adopted an abandoned delivery")
                    await self._slots.acquire()
                    await self._dispatch(entry)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("the janitor pass failed")

            await asyncio.sleep(JANITOR_INTERVAL_SECONDS)

    # ── One delivery ─────────────────────────────────────────────────────────

    async def _dispatch(self, entry: Delivery | UndecodableEntry) -> None:
        """Conclude one entry. The caller must hold a slot; this releases it."""
        if isinstance(entry, UndecodableEntry):
            # Straight to the dead-letter list. This is the criterion that a
            # payload failing schema validation is not retried forever: there
            # is nothing to retry it *with*.
            try:
                logger.error(
                    "undecodable job entry",
                    extra={"entry_id": entry.entry_id, "error_code": entry.failure.code.value},
                )
                await self._queue.dead_letter(
                    raw=entry.raw,
                    error_code=entry.failure.code,
                    message=entry.failure.message,
                    attempts=0,
                )
                await self._queue.ack(entry.entry_id)
            finally:
                self._slots.release()
            return

        task = asyncio.create_task(self._run(entry), name=f"konusbitr-job-{entry.payload.jobId}")
        self._in_flight.add(task)

        def finished(completed: asyncio.Task[None]) -> None:
            self._in_flight.discard(completed)
            self._slots.release()

        task.add_done_callback(finished)

    async def _run(self, delivery: Delivery) -> None:
        payload = delivery.payload
        with job_context(job_id=payload.jobId, doc_id=payload.documentId, org_id=payload.orgId):
            try:
                await self._run_inner(delivery)
            except Exception:  # pragma: no cover - the inner method handles its own
                logger.exception("job handling raised past its own error handling")
            finally:
                self._processed += 1

    async def _run_inner(self, delivery: Delivery) -> None:
        payload = delivery.payload
        progress = ProgressReporter(payload=payload, queue=self._queue, database=self._database)

        logger.info("job started", extra={"type": payload.type.value, "attempt": payload.attempt})

        watcher = _CancelWatcher(queue=self._queue, job_id=payload.jobId)
        try:
            await self._database.start_job(
                payload.jobId, payload.attempt, document_id=payload.documentId
            )
            async with watcher:
                outcome = await asyncio.wait_for(
                    self._handle(payload, progress, watcher.requested),
                    timeout=self._settings.worker_job_timeout_seconds,
                )
        except JobCancelled as stopped:
            await self._conclude_cancellation(delivery, stopped, progress)
            return
        except Exception as error:
            await self._conclude_failure(delivery, classify_exception(error))
            return

        await self._database.complete_job(
            job_id=payload.jobId,
            document_id=payload.documentId,
            page_count=outcome.page_count,
            result=outcome.result(),
        )
        await progress.stage(
            JobStage.ready,
            message="Reused an earlier parse" if outcome.reused else "Ready",
        )
        await self._queue.ack(delivery.entry_id)
        logger.info("job finished", extra={"reused": outcome.reused})

    #: Job types the pipeline knows how to run.
    #:
    #: All three go to the same handler, which differs only in which
    #: short-circuits it applies: `parse` does everything that is not already
    #: done, `chunk_embed` skips the parse, and `reindex` re-chunks and
    #: re-embeds unconditionally. `split` is still only vocabulary — it is in
    #: the contract so both runtimes agree the word exists — and an unknown
    #: type stays terminal rather than retrying three times to reach the same
    #: dead-letter list.
    _HANDLED = frozenset({JobType.parse, JobType.chunk_embed, JobType.reindex})

    async def _handle(
        self,
        payload: JobPayload,
        progress: ProgressReporter,
        cancelled: Callable[[], bool],
    ) -> JobOutcome:
        if payload.type in self._HANDLED:
            return await run_job(
                payload,
                database=self._database,
                progress=progress,
                settings=self._settings,
                store=self._store,
                cancelled=cancelled,
            )

        raise JobFailure(
            JobErrorCode.unknown_job_type,
            f"This worker has no handler for {payload.type.value!r} jobs.",
        )

    async def _conclude_cancellation(
        self,
        delivery: Delivery,
        stopped: JobCancelled,
        progress: ProgressReporter,
    ) -> None:
        """Conclude a job that was stopped on purpose.

        Every line here is deliberately *not* what `_conclude_failure` does. No
        retry is scheduled, because the job did not fail and re-running it
        would undo the stop. No dead letter is written, because a dead letter
        is a thing an operator is asked to look at. And the document is marked
        `cancelled` rather than `failed`, because a library that badges a
        deliberate stop in red is telling its reader something untrue.

        The flag is cleared last. Left behind it would cancel the *next* job
        for this document — including the retry a reader might start a second
        later, which would look exactly like the product ignoring them.
        """
        payload = delivery.payload
        logger.info(
            "job cancelled",
            extra={"pages_done": stopped.pages_done, "pages_total": stopped.pages_total},
        )

        await self._database.cancel_job(
            job_id=payload.jobId,
            document_id=payload.documentId,
            message=stopped.message,
        )
        await progress.cancelled(message=stopped.message)
        await self._queue.ack(delivery.entry_id)
        await self._queue.clear_cancel(payload.jobId)

    async def _conclude_failure(self, delivery: Delivery, failure: JobFailure) -> None:
        payload = delivery.payload
        attempts_left = self._settings.worker_max_attempts - payload.attempt
        terminal = not failure.retryable or attempts_left <= 0

        logger.warning(
            "job failed",
            extra={
                "error_code": failure.code.value,
                "retryable": failure.retryable,
                "attempt": payload.attempt,
                "terminal": terminal,
            },
        )

        await self._database.fail_job(
            job_id=payload.jobId,
            document_id=payload.documentId,
            error_code=failure.code.value,
            message=failure.message,
            terminal=terminal,
        )

        if terminal:
            await self._queue.dead_letter(
                raw=delivery.raw,
                error_code=failure.code,
                message=failure.message,
                attempts=payload.attempt,
            )
            await ProgressReporter(
                payload=payload, queue=self._queue, database=self._database
            ).failed(code=failure.code, message=failure.message)
        else:
            delay = self._settings.worker_retry_base_seconds * (2 ** (payload.attempt - 1))
            await self._queue.schedule_retry(
                payload.model_copy(update={"attempt": payload.attempt + 1}),
                delay_seconds=delay,
            )
            logger.info("retry scheduled", extra={"in_seconds": delay})

        # Acknowledged either way: the entry has reached a conclusion, and a
        # retry is a *new* entry. Leaving it pending would have the janitor
        # reclaim it later and run it a second time alongside the retry.
        await self._queue.ack(delivery.entry_id)

    # ── Introspection ────────────────────────────────────────────────────────

    async def snapshot(self) -> dict[str, Any]:
        return {
            "consumer": self._queue.consumer,
            "concurrency": self._settings.worker_concurrency,
            "inFlight": self.in_flight,
            "processed": self._processed,
            "queue": await self._queue.depth(),
        }


class _CancelWatcher:
    """Polls one job's cancellation flag while it runs.

    A background poll rather than a check at each decision point, for one
    reason: the predicate has to be answerable **synchronously**, from inside
    the worker threads where recognition happens. There is no event loop on
    those threads to await a Redis round trip on, so the loop caches the answer
    and the threads read the cached boolean.

    The cache is why the phase's two-second budget is reachable at all. A
    cancellation is noticed within one poll interval plus one page, rather than
    within one sixteen-page batch.

    Failing to reach Redis is *not* a cancellation. Guessing wrong in that
    direction stops a document halfway for no reason the reader can see, so an
    unreachable Redis leaves the flag as it was and the job carries on.
    """

    __slots__ = ("_flag", "_job_id", "_queue", "_task")

    def __init__(self, *, queue: JobQueue, job_id: str) -> None:
        self._queue = queue
        self._job_id = job_id
        self._flag = False
        self._task: asyncio.Task[None] | None = None

    def requested(self) -> bool:
        """Whether a stop has been asked for. Safe to call from any thread."""
        return self._flag

    async def __aenter__(self) -> _CancelWatcher:
        # Asked once before the job starts, so a cancellation made while the
        # job was queued is honoured immediately rather than a page in.
        self._flag = await self._queue.is_cancelled(self._job_id)
        self._task = asyncio.create_task(self._poll(), name=f"konusbitr-cancel-{self._job_id}")
        return self

    async def __aexit__(self, *_: object) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _poll(self) -> None:
        while not self._flag:
            await asyncio.sleep(CANCEL_POLL_SECONDS)
            self._flag = await self._queue.is_cancelled(self._job_id)
