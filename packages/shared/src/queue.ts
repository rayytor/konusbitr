/**
 * The Redis keys the two runtimes meet on.
 *
 * These names are as much a part of the cross-language contract as the payload
 * schema is — a worker listening on the wrong stream is exactly as broken as a
 * worker parsing the wrong JSON, and far more confusing to diagnose, because
 * everything looks healthy and nothing happens. So they are declared here once
 * and **generated into the Python side** by `pnpm codegen` alongside the
 * pydantic models, which makes a rename that misses one runtime unmergeable
 * rather than merely unlucky.
 *
 * `docs/adr/0001-queue.md` records why the transport is a Redis stream with a
 * consumer group rather than BullMQ or arq.
 */

/** The stream jobs are appended to with `XADD`. */
export const JOBS_STREAM = 'konusbitr:jobs';

/** The consumer group every worker joins, so one delivery goes to one worker. */
export const JOBS_CONSUMER_GROUP = 'konusbitr:workers';

/**
 * Jobs waiting out a backoff, scored by the epoch millisecond they become due.
 *
 * Redis streams have no delayed delivery, and leaving a failed job in the
 * pending-entries list to be reclaimed later would give every retry the same
 * fixed delay. A sorted set the worker drains on a timer gives real
 * exponential backoff for one `ZRANGEBYSCORE` a second.
 */
export const JOBS_RETRY_ZSET = 'konusbitr:jobs:retry';

/**
 * Where a job goes when it can never succeed.
 *
 * A list rather than another stream: nothing consumes it automatically, an
 * operator reads it with `LRANGE`, and `GET /api/admin/jobs/failed` renders it.
 */
export const JOBS_DEAD_LETTER = 'konusbitr:jobs:dead';

/** Trim the stream to roughly this many entries on every append. */
export const JOBS_STREAM_MAX_LENGTH = 10_000;

/** Keep at most this many dead letters; the oldest are dropped. */
export const DEAD_LETTER_MAX_LENGTH = 1_000;

/** The field name inside a stream entry that carries the JSON payload. */
export const JOBS_STREAM_FIELD = 'payload';

/**
 * The channel a document's progress is published on. Read over SSE by the
 * browser — Konusbitr has no WebSockets anywhere.
 */
export function progressChannel(documentId: string): string {
  return `konusbitr:progress:${documentId}`;
}

/** The literal prefix of {@link progressChannel}, for the generated Python half. */
export const PROGRESS_CHANNEL_PREFIX = 'konusbitr:progress:';

/**
 * The key that asks a running job to stop.
 *
 * A Redis key rather than a message, because the two runtimes do not share a
 * control channel and a cancellation has to survive the worker not being the
 * one that was listening. The web app sets it; the worker polls it between
 * pages and drops the job at the next boundary.
 *
 * It is a *request*, not a command: a job that has already finished ignores it,
 * and a job that is mid-batch finishes that page first so that nothing is left
 * half-written. What the key guarantees is that the job stops soon, not that it
 * stops instantly.
 */
export const CANCEL_KEY_PREFIX = 'konusbitr:cancel:';

export function cancelKey(jobId: string): string {
  return `${CANCEL_KEY_PREFIX}${jobId}`;
}

/**
 * How long a cancellation request lives if nothing consumes it.
 *
 * Longer than the longest job may run, so a request set while a worker is
 * restarting is still there when it comes back — and finite, so a key for a job
 * that will never run again does not outlive the Redis instance. The worker
 * deletes it when it acts on it.
 */
export const CANCEL_TTL_SECONDS = 3600;
