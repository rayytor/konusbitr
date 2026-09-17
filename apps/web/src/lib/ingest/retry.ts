import { scopedDb } from '@konusbitr/db';
import {
  cancelKey,
  DEFAULT_PARSE_SETTINGS,
  type ParseSettings,
  ParseSettingsSchema,
} from '@konusbitr/shared';
import { db } from '../db';
import { redis } from '../redis';
import { IngestError } from './errors';
import { settingsHash } from './inspect';
import { enqueueJob } from './queue';

/**
 * Run a document's ingest again — optionally at different parse settings.
 *
 * The endpoint behind "Retry with settings". A document reaches it in one of
 * three states, and the interesting thing about the feature is that only one of
 * them is a plain retry:
 *
 * - **failed** for a reason the settings could change. A scan refused with
 *   `needs_ocr` on a deployment that has since installed the engines, or a
 *   document a reader wants to try at `quality: 'advanced'`.
 * - **cancelled**, which is somebody changing their mind back.
 * - **stuck**, a `queued` document whose job was lost. Rare, and the reason
 *   this does not refuse anything that is not terminal.
 *
 * Changing the settings changes the document's *identity*. `settings_hash` is
 * half the docId cache key precisely because the same PDF parsed two ways is
 * two parses, so a retry at new settings rewrites the hash on the row — and
 * must first check whether this org already holds a document at those hashes,
 * because the uniqueness constraint would otherwise refuse the update with a
 * message nobody can act on. When it does, the existing document is the answer
 * and no job is queued: that is a cache hit, arrived at from an unusual
 * direction.
 *
 * The bytes never move. Retrying is re-reading what is already in storage, so
 * it costs a parse and not an upload, and the storage key is untouched.
 *
 * One consequence worth knowing: a retry **at the same settings** after a
 * cancellation resumes rather than starting over, because the half-finished
 * `parse_results` row is still keyed on the same pair of hashes and the worker
 * finds its checkpoint. That is the cheap answer and it is also the same
 * answer — the same settings over the same bytes produce the same document, so
 * re-reading the first 140 pages would buy nothing. A retry at *different*
 * settings changes `settings_hash`, finds no checkpoint, and reads the whole
 * document, which is what asking for a different parse means.
 */
export async function requestRetry(input: {
  orgId: string;
  documentId: string;
  settings?: ParseSettings;
}): Promise<{ jobId: string | null; documentId: string; reused: boolean }> {
  const scoped = scopedDb(db(), input.orgId);

  // Org-scoped, so another tenant's document is *absent* rather than
  // forbidden: a 403 would confirm the id exists.
  const document = await scoped.documentById(input.documentId);
  if (!document) throw IngestError.notFound('No document with that id.');

  if (document.status === 'parsing' || document.status === 'ocr') {
    throw IngestError.unprocessable(
      'already_running',
      'That document is being processed right now. Cancel it first if you want to start again.',
    );
  }

  const settings = ParseSettingsSchema.parse(input.settings ?? DEFAULT_PARSE_SETTINGS);
  const nextHash = settingsHash(settings);

  if (nextHash !== document.settingsHash) {
    const twin = await scoped.documentByHashes(document.contentHash, nextHash);
    if (twin && twin.id !== document.id) {
      // Already parsed at these settings, under a different id. Handing that
      // document back is both the cheapest answer and the honest one — a
      // second row for the same bytes at the same settings is exactly what the
      // uniqueness constraint exists to prevent.
      return { jobId: null, documentId: twin.id, reused: true };
    }
  }

  // Unconditional, because the same hash still has to clear the status, the
  // error and the counters a previous run left behind.
  await scoped.reparseDocument(document.id, nextHash);

  const job = await scoped.createJob({
    documentId: document.id,
    type: 'parse',
    payload: { settings, storageKey: document.storageKey },
  });
  if (!job) throw new Error('the retry job row could not be created');

  // A cancellation flag left over from the stop that led to this retry would
  // cancel the retry within half a second of it starting, which would look
  // exactly like the product ignoring the button. The worker clears it too;
  // clearing it here as well closes the window between the two.
  const previous = await scoped.latestJobForDocument(document.id);
  if (previous && previous.id !== job.id) await redis().del(cancelKey(previous.id));

  await enqueueJob('parse', {
    jobId: job.id,
    orgId: input.orgId,
    documentId: document.id,
    storageKey: document.storageKey,
    contentHash: document.contentHash,
    settings,
  });

  return { jobId: job.id, documentId: document.id, reused: false };
}
