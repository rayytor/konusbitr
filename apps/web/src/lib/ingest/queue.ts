import {
  JOB_PAYLOAD_VERSION,
  JOBS_STREAM,
  JOBS_STREAM_FIELD,
  JOBS_STREAM_MAX_LENGTH,
  type JobPayload,
  JobPayloadSchema,
  type JobProgress,
  JobProgressSchema,
  type JobType,
} from '@konusbitr/shared';
import { redis } from '../redis';

/**
 * Handing a document to the Python half.
 *
 * The entire contract between the two runtimes is this stream and a JSON
 * payload — no shared ORM, no RPC framework, no imports across the boundary.
 * That seam is what keeps a two-language codebase contributable, so it is
 * deliberately the smallest thing that could work, and the payload's shape is
 * generated into the worker's pydantic models from the same Zod schema this
 * file validates against. `docs/adr/0001-queue.md` records why it is a stream
 * with a consumer group rather than BullMQ or arq.
 *
 * The one thing to understand before changing anything here: a *list* is not
 * good enough. `RPUSH`/`BLPOP` hands a job to a worker and immediately forgets
 * it, so a worker killed mid-parse takes the job to the grave with it. A
 * stream entry stays in the consumer group's pending list until the worker
 * acknowledges it, which is the whole of Phase 06's crash-recovery story.
 */

export type EnqueueJob = Omit<JobPayload, 'v' | 'attempt' | 'enqueuedAt' | 'type'>;

/** @deprecated Kept as the name Phase 05 introduced; prefer {@link enqueueJob}. */
export type EnqueueParseJob = EnqueueJob;

/**
 * Append a job of a given type.
 *
 * The envelope is identical for every type — the same document, the same bytes,
 * the same settings — and only `type` says what the worker should do with it.
 * That is deliberate: a `reindex` is not a different message, it is the same
 * message with the parse short-circuit switched off, which is what makes
 * "switch the embedding model and reindex" cost embeddings rather than a second
 * pass over every PDF.
 *
 * Validated on the way out, not merely typed: this is the one place a payload
 * becomes bytes another language will parse, and a runtime check here turns
 * "the worker dead-letters everything and nobody knows why" into a 500 with a
 * stack trace pointing at the caller.
 */
export async function enqueueJob(type: JobType, job: EnqueueJob): Promise<string> {
  const payload = JobPayloadSchema.parse({
    v: JOB_PAYLOAD_VERSION,
    type,
    attempt: 1,
    enqueuedAt: new Date().toISOString(),
    ...job,
  } satisfies JobPayload);

  // `MAXLEN ~` trims lazily at whole-node boundaries, which is what makes the
  // cap free. Acknowledged entries are not removed by `XACK` — they only stop
  // being redeliverable — so without a cap the stream is an append-only log of
  // every job the instance has ever run.
  return redis().xadd(
    JOBS_STREAM,
    'MAXLEN',
    '~',
    String(JOBS_STREAM_MAX_LENGTH),
    '*',
    JOBS_STREAM_FIELD,
    JSON.stringify(payload),
  ) as Promise<string>;
}

/** Append a parse job — the intake path's only use of the queue. */
export function enqueueParseJob(job: EnqueueJob): Promise<string> {
  return enqueueJob('parse', job);
}

/**
 * Parse a progress frame published by the worker.
 *
 * Returns `undefined` for anything that does not validate. The SSE route drops
 * those silently rather than tearing the stream down: a malformed frame is a
 * worker-side bug, and killing the browser's connection over it would replace
 * a missing progress bar with a page that looks broken.
 */
export function parseProgress(message: string): JobProgress | undefined {
  try {
    const result = JobProgressSchema.safeParse(JSON.parse(message));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
