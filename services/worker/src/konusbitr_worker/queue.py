"""The Redis-stream transport, and everything the worker does to an entry.

One consumer group on one stream. A delivery goes to exactly one consumer; the
consumer acknowledges it when the job has reached a conclusion, and until then
the entry sits in that consumer's pending-entries list where a restart — of
this process or of a sibling — can find it again. That is the whole recovery
story, and it is why the transport is a stream rather than the list Phase 05
wrote to: ``BLPOP`` hands a job over and forgets it, so a worker killed
mid-parse takes the job with it.

See ``docs/adr/0001-queue.md`` for why this is hand-rolled rather than BullMQ
or arq. The short version: the payload is generated from one Zod schema and is
plain JSON, and neither library's job wrapper can be spoken by the other's
runtime without reimplementing its encoding — which is exactly the drift this
architecture exists to avoid.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import redis.asyncio as redis
from pydantic import ValidationError

from konusbitr_worker.contracts import (
    DEAD_LETTER_MAX_LENGTH,
    JOB_PAYLOAD_VERSION,
    JOBS_CONSUMER_GROUP,
    JOBS_DEAD_LETTER,
    JOBS_RETRY_ZSET,
    JOBS_STREAM,
    JOBS_STREAM_FIELD,
    JOBS_STREAM_MAX_LENGTH,
    JobErrorCode,
    JobPayload,
    JobProgress,
    progress_channel,
)
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.log import get_logger

__all__ = ["Delivery", "JobQueue", "UndecodableEntry"]

logger = get_logger("konusbitr.worker.queue")


@dataclass(frozen=True, slots=True)
class Delivery:
    """One stream entry that decoded into a valid job."""

    entry_id: str
    payload: JobPayload
    raw: str


@dataclass(frozen=True, slots=True)
class UndecodableEntry:
    """One stream entry that did not.

    Kept as a distinct type rather than raised, because the *only* correct
    response is to dead-letter it and acknowledge: a payload that fails schema
    validation will fail it again on every redelivery, and retrying it forever
    is how a queue turns one bad message into an outage.
    """

    entry_id: str
    raw: str
    failure: JobFailure


class JobQueue:
    """Everything the worker does to the stream, the retry set and the dead letters."""

    def __init__(self, client: redis.Redis, *, consumer: str) -> None:
        self._redis = client
        self._consumer = consumer

    @classmethod
    def connect(cls, url: str, *, consumer: str) -> JobQueue:
        return cls(
            redis.from_url(url, decode_responses=True, health_check_interval=30),
            consumer=consumer,
        )

    @property
    def consumer(self) -> str:
        return self._consumer

    async def close(self) -> None:
        await self._redis.aclose()

    async def ping(self) -> None:
        """Raise if Redis is not answering. Used by ``/health`` and ``/ready``."""
        await self._redis.ping()

    async def ensure_group(self) -> None:
        """Create the consumer group, starting from the beginning of the stream.

        ``id="0"`` rather than ``"$"`` on purpose: a job enqueued before any
        worker had ever started is still a job someone is waiting on, and ``$``
        would skip it silently — the worst possible failure mode for a queue,
        because everything looks healthy.
        """
        try:
            await self._redis.xgroup_create(JOBS_STREAM, JOBS_CONSUMER_GROUP, id="0", mkstream=True)
            logger.info("created consumer group", extra={"group": JOBS_CONSUMER_GROUP})
        except redis.ResponseError as error:
            if "BUSYGROUP" not in str(error):
                raise

    # ── Reading ──────────────────────────────────────────────────────────────

    async def read(self, *, count: int, block_ms: int) -> list[Delivery | UndecodableEntry]:
        """Take new entries off the stream."""
        return await self._read_from(">", count=count, block_ms=block_ms)

    async def read_own_pending(self, *, count: int) -> list[Delivery | UndecodableEntry]:
        """Re-take entries this consumer was handed and never acknowledged.

        This is the restart path. The consumer name is stable for the life of a
        container, so a worker that was killed mid-job finds its own unfinished
        delivery waiting under the same name and picks it back up — which is
        what makes "kill the worker mid-job and it still completes exactly
        once" true rather than aspirational.
        """
        return await self._read_from("0", count=count, block_ms=0)

    async def _read_from(
        self, start: str, *, count: int, block_ms: int
    ) -> list[Delivery | UndecodableEntry]:
        response = await self._redis.xreadgroup(
            groupname=JOBS_CONSUMER_GROUP,
            consumername=self._consumer,
            streams={JOBS_STREAM: start},
            count=count,
            block=block_ms or None,
        )

        results: list[Delivery | UndecodableEntry] = []
        for _stream, entries in response or []:
            for entry_id, fields in entries:
                results.append(decode(entry_id, fields))
        return results

    async def claim_abandoned(self, *, min_idle_ms: int, count: int) -> list[Any]:
        """Take over entries another consumer stopped working on.

        A replica that is killed and never comes back leaves its pending
        entries owned by a name nobody will use again. ``XAUTOCLAIM`` is how
        those become someone else's problem instead of nobody's.
        """
        _cursor, entries, _deleted = await self._redis.xautoclaim(
            name=JOBS_STREAM,
            groupname=JOBS_CONSUMER_GROUP,
            consumername=self._consumer,
            min_idle_time=min_idle_ms,
            start_id="0-0",
            count=count,
        )
        return [decode(entry_id, fields) for entry_id, fields in entries]

    async def ack(self, entry_id: str) -> None:
        """This entry has reached a conclusion and must not be redelivered."""
        await self._redis.xack(JOBS_STREAM, JOBS_CONSUMER_GROUP, entry_id)

    # ── Writing ──────────────────────────────────────────────────────────────

    async def enqueue(self, payload: JobPayload) -> str:
        """Append a job. Used by retries, and by the tests that stand in for the web app."""
        return await self._redis.xadd(
            JOBS_STREAM,
            {JOBS_STREAM_FIELD: payload.model_dump_json()},
            maxlen=JOBS_STREAM_MAX_LENGTH,
            approximate=True,
        )

    async def schedule_retry(self, payload: JobPayload, *, delay_seconds: float) -> None:
        """Park a job until its backoff has elapsed."""
        due_at_ms = int(time.time() * 1000 + delay_seconds * 1000)
        await self._redis.zadd(JOBS_RETRY_ZSET, {payload.model_dump_json(): due_at_ms})

    async def promote_due_retries(self, *, limit: int = 32) -> int:
        """Move every job whose backoff has elapsed back onto the stream.

        ``ZREM`` is the lock: several workers may see the same due entry, and
        only the one whose removal actually deleted it goes on to re-enqueue,
        so a retry is promoted exactly once however many replicas are running.
        """
        now_ms = int(time.time() * 1000)
        due = await self._redis.zrangebyscore(
            JOBS_RETRY_ZSET, min=0, max=now_ms, start=0, num=limit
        )

        promoted = 0
        for raw in due:
            if not await self._redis.zrem(JOBS_RETRY_ZSET, raw):
                continue
            await self._redis.xadd(
                JOBS_STREAM,
                {JOBS_STREAM_FIELD: raw},
                maxlen=JOBS_STREAM_MAX_LENGTH,
                approximate=True,
            )
            promoted += 1
        return promoted

    async def dead_letter(
        self,
        *,
        raw: str,
        error_code: JobErrorCode,
        message: str,
        attempts: int,
    ) -> None:
        """Put a job somewhere an operator can find it, and stop touching it."""
        entry = json.dumps(
            {
                "payload": raw,
                "errorCode": error_code.value,
                "error": message,
                "attempts": attempts,
                "failedAt": _now_iso(),
                "consumer": self._consumer,
            }
        )
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.lpush(JOBS_DEAD_LETTER, entry)
            pipe.ltrim(JOBS_DEAD_LETTER, 0, DEAD_LETTER_MAX_LENGTH - 1)
            await pipe.execute()

        logger.error(
            "job dead-lettered",
            extra={"error_code": error_code.value, "attempts": attempts},
        )

    async def publish_progress(self, progress: JobProgress) -> None:
        """Broadcast on the document's channel. Relayed to the browser over SSE."""
        await self._redis.publish(progress_channel(progress.documentId), progress.model_dump_json())

    # ── Introspection ────────────────────────────────────────────────────────

    async def depth(self) -> dict[str, int]:
        """Rough queue sizes, for ``/health``."""
        pending = 0
        try:
            summary = await self._redis.xpending(JOBS_STREAM, JOBS_CONSUMER_GROUP)
            pending = int(summary["pending"]) if summary else 0
        except redis.ResponseError:
            # No group yet; nothing is pending by definition.
            pending = 0

        return {
            "stream": int(await self._redis.xlen(JOBS_STREAM)),
            "pending": pending,
            "retrying": int(await self._redis.zcard(JOBS_RETRY_ZSET)),
            "dead": int(await self._redis.llen(JOBS_DEAD_LETTER)),
        }


def decode(entry_id: str, fields: dict[str, str]) -> Delivery | UndecodableEntry:
    """Turn a stream entry into a validated job, or into a reason it is not one."""
    raw = fields.get(JOBS_STREAM_FIELD, "")

    if not raw:
        return UndecodableEntry(
            entry_id,
            json.dumps(fields),
            JobFailure(
                JobErrorCode.invalid_payload,
                f"the stream entry has no {JOBS_STREAM_FIELD!r} field",
            ),
        )

    try:
        document = json.loads(raw)
    except ValueError:
        return UndecodableEntry(
            entry_id,
            raw,
            JobFailure(JobErrorCode.invalid_payload, "the stream entry is not valid JSON"),
        )

    # Checked before the model, so that a future envelope produces "I am too
    # old to read this" rather than a list of fields that moved.
    version = document.get("v") if isinstance(document, dict) else None
    if version != JOB_PAYLOAD_VERSION:
        return UndecodableEntry(
            entry_id,
            raw,
            JobFailure(
                JobErrorCode.unsupported_version,
                f"job envelope v{version} is not v{JOB_PAYLOAD_VERSION}; "
                "this worker is older than the app that enqueued it",
            ),
        )

    try:
        return Delivery(entry_id, JobPayload.model_validate(document), raw)
    except ValidationError as error:
        return UndecodableEntry(
            entry_id,
            raw,
            JobFailure(
                JobErrorCode.invalid_payload,
                "; ".join(
                    f"{'.'.join(str(part) for part in issue['loc'])}: {issue['msg']}"
                    for issue in error.errors()
                ),
            ),
        )


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()
