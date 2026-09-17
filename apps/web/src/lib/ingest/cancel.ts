import { scopedDb } from '@konusbitr/db';
import {
  CANCEL_TTL_SECONDS,
  cancelKey,
  type JobProgress,
  progressChannel,
  STAGE_PERCENT,
} from '@konusbitr/shared';
import { db } from '../db';
import { redis } from '../redis';
import { IngestError } from './errors';

/**
 * Asking a running ingest to stop.
 *
 * The request crosses the runtime seam as a Redis key rather than as a
 * message, for the same reason the job itself crosses as a stream entry: the
 * two halves share no control channel, and a cancellation has to survive the
 * worker not having been listening at the moment it was made. The worker polls
 * the key twice a second while a job runs, stops at the next page boundary,
 * purges its scratch files and marks the job cancelled.
 *
 * Three things are true of it that are worth stating plainly, because each is
 * a decision somebody could reasonably have made differently.
 *
 * **It is a request, not a kill.** Nothing is interrupted mid-page. A page half
 * recognised and half written is worse than a page that finishes, and the cost
 * of finishing one is a second.
 *
 * **What was indexed stays indexed.** A batched parse commits as it goes —
 * chunks, vectors, page rows, thumbnails — so a document cancelled at page 140
 * of 900 is a 140-page document that can be read and searched, not a broken
 * one. That is why the status is `cancelled` rather than `failed`, and why the
 * error message says how far it got.
 *
 * **The document is marked immediately, here.** The worker will write the same
 * thing when it notices, and both writes are idempotent. Doing it from this
 * side as well is what makes the button feel like a button: the phase asks for
 * a cancellation to take effect within two seconds, and a reader watching a
 * spinner should not have to wait for a page of OCR to finish before the
 * screen admits they pressed it.
 */
export async function requestCancel(input: {
  orgId: string;
  documentId: string;
}): Promise<{ jobId: string | null; documentId: string; status: string }> {
  const scoped = scopedDb(db(), input.orgId);

  // Org-scoped, so another tenant's document is *absent* rather than
  // forbidden: a 403 would confirm the id exists.
  const document = await scoped.documentById(input.documentId);
  if (!document) throw IngestError.notFound('No document with that id.');

  if (document.status === 'ready' || document.status === 'cancelled') {
    // Not an error. Cancelling something that has already stopped is a
    // double-click, and answering a double-click with a 4xx is noise.
    return { jobId: null, documentId: document.id, status: document.status };
  }

  const job = await scoped.latestJobForDocument(document.id);
  if (job) {
    await redis().set(cancelKey(job.id), '1', 'EX', CANCEL_TTL_SECONDS);
  }

  const pagesReady = document.pagesReady ?? 0;
  const pagesTotal = document.pagesTotal;
  const message = pagesTotal
    ? `Stopped at your request, after ${pagesReady} of ${pagesTotal} pages.`
    : 'Stopped at your request.';

  await scoped.markDocumentCancelled(document.id, message);

  // Published so the browser's progress stream shows the stop now rather than
  // at the next page boundary. The frame is the same shape the worker
  // publishes, so the client has no special case for it.
  if (job) {
    const frame: JobProgress = {
      jobId: job.id,
      documentId: document.id,
      stage: 'cancelled',
      percent: STAGE_PERCENT.cancelled,
      message,
      errorCode: 'cancelled',
      pagesReady,
      pagesTotal: pagesTotal ?? null,
      at: new Date().toISOString(),
    };
    await redis().publish(progressChannel(document.id), JSON.stringify(frame));
  }

  return { jobId: job?.id ?? null, documentId: document.id, status: 'cancelled' };
}
