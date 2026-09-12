import { scopedDb } from '@konusbitr/db';
import { DEFAULT_PARSE_SETTINGS, ParseSettingsSchema } from '@konusbitr/shared';
import { db } from '../db';
import { IngestError } from './errors';
import { enqueueJob } from './queue';

/**
 * Re-chunk and re-embed a document that has already been parsed.
 *
 * This is the operation that makes the docId cache *architecture* rather than
 * an optimisation. The chunker changes, or an operator switches
 * `EMBEDDING_MODEL` from `text-embedding-3-large` to a local BGE-M3 — both are
 * reasons to rebuild the index of every document in the library, and neither is
 * a reason to re-parse a single PDF. A reindex costs embeddings; a re-upload
 * would cost the whole pipeline again.
 *
 * It is deliberately not "delete the chunks and re-upload". Deleting first
 * would leave the document unsearchable for the duration, and a failure
 * halfway would leave it unsearchable indefinitely. The worker upserts on
 * `(document_id, ordinal)` and prunes what is past the end, so the old index
 * stays answerable until the new one has replaced it row by row.
 */
export async function requestReindex(input: { orgId: string; documentId: string }): Promise<{
  jobId: string;
  documentId: string;
}> {
  const scoped = scopedDb(db(), input.orgId);

  // Org-scoped, so another tenant's document is *absent* rather than
  // forbidden: a 403 would confirm the id exists.
  const document = await scoped.documentById(input.documentId);
  if (!document) throw IngestError.notFound('No document with that id.');

  // A document that never finished parsing has no artifact to index. The
  // answer is to let the original job finish or retry it, not to queue a
  // reindex that will fail on a cache miss.
  if (document.status !== 'ready' && document.status !== 'failed') {
    throw IngestError.unprocessable(
      'not_indexable_yet',
      'That document is still being processed. Wait for it to finish, then reindex.',
    );
  }

  const job = await scoped.createJob({
    documentId: document.id,
    type: 'reindex',
    payload: { storageKey: document.storageKey },
  });
  if (!job) throw new Error('the reindex job row could not be created');

  await enqueueJob('reindex', {
    jobId: job.id,
    orgId: input.orgId,
    documentId: document.id,
    storageKey: document.storageKey,
    contentHash: document.contentHash,
    // The document's original parse settings, which is what the artifact in the
    // cache was produced with. A reindex must not silently reparse at different
    // settings — that would be a different `settings_hash` and a cache miss.
    // Not authoritative, and cannot be: `documents` stores the settings *hash*
    // rather than the settings, so the originals are not recoverable from here.
    // It does not matter, because the worker keys its cache lookup off the
    // document row's `settings_hash` and never off the payload — the field is
    // present because the envelope requires one for every job type. If a later
    // phase ever needs a reindex to *re-parse*, this has to become the real
    // settings first, or it would silently parse at the defaults.
    settings: ParseSettingsSchema.parse(DEFAULT_PARSE_SETTINGS),
  });

  return { jobId: job.id, documentId: document.id };
}
