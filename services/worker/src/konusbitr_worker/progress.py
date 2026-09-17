"""Telling everyone where a job has got to.

Progress is written twice, to two things with different jobs.

The Redis publish is for a browser that is watching *right now*: it reaches the
SSE route within a millisecond and costs nothing when nobody is subscribed. The
`jobs` row is for a browser that is not — one that has just been refreshed, or
opened on a phone ten minutes later. Neither substitutes for the other. Publish
alone loses everything the moment a tab is closed; a row alone means polling,
and Konusbitr has no WebSockets to fall back to.

Both carry the same numbers, from the same `STAGE_PERCENT` table the
TypeScript side reads, so a reconnecting client sees the bar continue rather
than jump.
"""

from __future__ import annotations

from datetime import UTC, datetime

from konusbitr_worker.contracts import (
    STAGE_PERCENT,
    JobErrorCode,
    JobPayload,
    JobProgress,
    JobStage,
)
from konusbitr_worker.db import Database
from konusbitr_worker.log import get_logger
from konusbitr_worker.queue import JobQueue

__all__ = ["ProgressReporter"]

logger = get_logger("konusbitr.worker.progress")


class ProgressReporter:
    """Reports one job's progress. Created per delivery, never shared."""

    def __init__(self, *, payload: JobPayload, queue: JobQueue, database: Database) -> None:
        self._payload = payload
        self._queue = queue
        self._database = database
        self._highest = -1
        #: Pages read and pages in the document, once anything knows.
        #:
        #: Held on the reporter rather than passed to every call, because every
        #: frame should carry them once they are known — a browser that
        #: reconnects during embedding still wants to draw "900 of 900", and a
        #: caller that had to remember to thread them through each `stage()`
        #: would forget on the one path that mattered.
        self._pages_ready: int | None = None
        self._pages_total: int | None = None
        #: The last stage announced, so a page report can restate it rather
        #: than inventing one.
        self._stage: JobStage | None = None

    async def stage(
        self,
        stage: JobStage,
        *,
        message: str | None = None,
        percent: int | None = None,
    ) -> None:
        """Move the job to a stage and tell everyone.

        The percentage never goes backwards. A retry starts again at
        `fetching`, and a bar that slides back to 5% reads as "something went
        wrong" to someone who has not been told anything went wrong — so the
        stage is reported honestly and the number is clamped.
        """
        value = STAGE_PERCENT[stage] if percent is None else percent
        self._highest = max(self._highest, value)
        self._stage = stage

        await self._database.record_stage(
            job_id=self._payload.jobId,
            document_id=self._payload.documentId,
            stage=stage,
            percent=self._highest,
        )
        await self._publish(stage=stage, percent=self._highest, message=message)
        logger.info("stage", extra={"stage": stage.value, "percent": self._highest})

    def note_pages(self, *, ready: int, total: int) -> None:
        """Record where the parse has got to, without publishing anything.

        Every frame from here on carries these numbers, which is what a client
        needs: a browser reconnecting during embedding still wants to draw "900
        of 900". Separate from :meth:`pages` because a document read in one
        pass has named stages to report progress through and does not want a
        second frame per batch saying the same thing in a different unit.
        """
        self._pages_ready = ready
        self._pages_total = total

    async def pages(self, *, ready: int, total: int, message: str | None = None) -> None:
        """Report that another batch of pages has been read and indexed.

        Published without changing the stage, because a batch boundary is not a
        stage boundary: a 900-page document passes through `parsing` once and
        through fifty-six batches, and reporting each of them as a stage change
        would make a bar that jumps between 20% and 85% for a quarter of an
        hour.

        The percentage instead moves *within* the span the parse occupies, in
        proportion to the pages read. That is what turns a spinner into a bar
        on exactly the documents where the difference matters.
        """
        self._pages_ready = ready
        self._pages_total = total

        stage = self._stage or JobStage.parsing
        percent = _page_percent(ready=ready, total=total)
        self._highest = max(self._highest, percent)

        await self._database.record_stage(
            job_id=self._payload.jobId,
            document_id=self._payload.documentId,
            stage=stage,
            percent=self._highest,
        )
        await self._publish(stage=stage, percent=self._highest, message=message)

    async def cancelled(self, *, message: str) -> None:
        """Announce that the job stopped because somebody asked it to.

        A stage of its own rather than `failed` with a code, so that every
        consumer — the library badge, the progress stream, Phase 13's API —
        can tell a deliberate stop from a broken document without having to
        special-case an error code.
        """
        await self._publish(
            stage=JobStage.cancelled,
            percent=STAGE_PERCENT[JobStage.cancelled],
            message=message,
            error_code=JobErrorCode.cancelled,
        )

    async def failed(self, *, code: JobErrorCode, message: str) -> None:
        """Announce a final failure. Only called once the retries are spent."""
        await self._publish(
            stage=JobStage.failed,
            percent=STAGE_PERCENT[JobStage.failed],
            message=message,
            error_code=code,
        )

    async def _publish(
        self,
        *,
        stage: JobStage,
        percent: int,
        message: str | None = None,
        error_code: JobErrorCode | None = None,
    ) -> None:
        await self._queue.publish_progress(
            JobProgress(
                jobId=self._payload.jobId,
                documentId=self._payload.documentId,
                stage=stage,
                percent=percent,
                message=message,
                errorCode=error_code,
                pagesReady=self._pages_ready,
                pagesTotal=self._pages_total,
                at=datetime.now(UTC),
            )
        )


def _page_percent(*, ready: int, total: int) -> int:
    """Where a bar sits when `ready` of `total` pages have been read and indexed.

    Spread across the whole span from `parsing` to `persisting`, rather than
    from whatever stage the job happens to be in. That is the point of the
    measure: in a batched ingest the reading and the indexing *interleave* —
    page 17 is being recognised while pages 1 to 16 are being embedded — so
    there is no stage the bar could sit inside, and the fraction of pages done
    is the only honest statement about the job as a whole.

    The endpoints come from the shared `STAGE_PERCENT` table rather than being
    numbers of their own, so that a browser replaying from the `jobs` row lands
    in the same range the live frames drew in.
    """
    floor = STAGE_PERCENT[JobStage.parsing]
    ceiling = STAGE_PERCENT[JobStage.persisting]
    if total <= 0:
        return floor
    # Capped one below `persisting`: the last batch landing is not the same
    # event as the document being saved, and a bar that reaches 95% twice tells
    # a watcher nothing the first time.
    return min(floor + round((ceiling - floor) * ready / total), ceiling - 1)
