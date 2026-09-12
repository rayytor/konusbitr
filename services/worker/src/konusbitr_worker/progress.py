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

        await self._database.record_stage(
            job_id=self._payload.jobId,
            document_id=self._payload.documentId,
            stage=stage,
            percent=self._highest,
        )
        await self._publish(stage=stage, percent=self._highest, message=message)
        logger.info("stage", extra={"stage": stage.value, "percent": self._highest})

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
                at=datetime.now(UTC),
            )
        )
