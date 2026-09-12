import type { ParseSettings } from '@konusbitr/shared';
import { redis } from '../redis';

/**
 * Handing a document to the Python half.
 *
 * The entire contract between the two runtimes is this list and a JSON payload
 * — no shared ORM, no RPC framework, no imports across the boundary. That seam
 * is what keeps a two-language codebase contributable, so it is deliberately
 * the smallest thing that could work.
 *
 * **Phase 05 ends here.** Nothing consumes this queue yet; Phase 06 brings up
 * the worker and, with it, the generated payload schema that replaces the
 * hand-written shape below. What is written now is the minimum a worker needs
 * to find the bytes and know what to do with them, and it is versioned so the
 * Phase 06 consumer can tell an old envelope from a new one.
 */

/** The list the worker will block on. */
export const JOBS_QUEUE = 'konusbitr:jobs';

/** The channel progress is published to, per document. Read over SSE, never a socket. */
export function progressChannel(documentId: string): string {
  return `konusbitr:progress:${documentId}`;
}

export type ParseJobEnvelope = {
  v: 1;
  jobId: string;
  type: 'parse';
  orgId: string;
  documentId: string;
  storageKey: string;
  settings: ParseSettings;
  enqueuedAt: string;
};

export async function enqueueParseJob(
  envelope: Omit<ParseJobEnvelope, 'v' | 'enqueuedAt'>,
): Promise<void> {
  const payload: ParseJobEnvelope = {
    v: 1,
    ...envelope,
    enqueuedAt: new Date().toISOString(),
  };

  // `rpush` with a blocking `blpop` at the other end gives FIFO ordering and
  // costs nothing while the queue is empty.
  await redis().rpush(JOBS_QUEUE, JSON.stringify(payload));
}
