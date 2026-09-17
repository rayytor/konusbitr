import { type DocumentRow, globalParseResultByHashes, scopedDb } from '@konusbitr/db';
import {
  DEFAULT_PARSE_SETTINGS,
  type DocumentView,
  type ParseSettings,
  ParseSettingsSchema,
} from '@konusbitr/shared';
import { documentPrefix } from '@konusbitr/storage';
import { db } from '../db';
import { loadWebEnv } from '../env';
import { storage } from '../storage';
import { enqueueParseJob } from './queue';
import { estimateFor, recordEstimate } from './vlm';

/**
 * The docId cache, which is the reason this phase exists.
 *
 * Parse once, reuse forever, at zero cost. The key is
 * `sha256(file bytes) + sha256(canonical_json(parse settings))`, and Phase 03's
 * `UNIQUE (org_id, content_hash, settings_hash)` on `documents` is what makes
 * the rule enforceable rather than advisory: two uploads of the same bytes with
 * the same settings *cannot* become two documents, whatever a race does.
 *
 * Three outcomes, in order:
 *
 * 1. This organization already has the document → return it, charge nothing,
 *    enqueue nothing. Milliseconds.
 * 2. `ALLOW_GLOBAL_PARSE_CACHE` is on and some organization has a finished
 *    parse for these bytes → create the document already `ready`, charge
 *    nothing, enqueue nothing. **Off by default**; see the flag's own note.
 * 3. Otherwise → create it `queued` and enqueue a parse job.
 */

export type ResolveInput = {
  orgId: string;
  /** Reserved before the upload, because the storage key is derived from it. */
  documentId: string;
  storageKey: string;
  filename: string;
  mime: string;
  byteSize: number;
  pageCount: number | null;
  contentHash: string;
  settingsHash: string;
  settings: ParseSettings;
  folderId?: string | null;
  sourceUrl?: string | null;
};

export type ResolveResult = {
  document: DocumentRow;
  /** True when no job was enqueued because the parse already existed. */
  cached: boolean;
};

export async function resolveDocument(input: ResolveInput): Promise<ResolveResult> {
  const env = loadWebEnv();
  const scoped = scopedDb(db(), input.orgId);

  // 1 — this org already has it, finished or still in flight. Either way there
  // is nothing to do: a second upload of a document that is halfway through
  // parsing should join the job that exists, not start a rival one.
  const existing = await scoped.documentByHashes(input.contentHash, input.settingsHash);
  if (existing) {
    await scoped.recordCredit({
      delta: 0,
      reason: 'cache_hit',
      refId: existing.id,
      metadata: { contentHash: input.contentHash, settingsHash: input.settingsHash },
    });
    return { document: existing, cached: true };
  }

  // 2 — the operator has opted into sharing parses between tenants.
  if (env.ALLOW_GLOBAL_PARSE_CACHE) {
    const shared = await globalParseResultByHashes(db(), input.contentHash, input.settingsHash);
    if (shared) {
      const document = await createDocument(scoped, input, {
        status: 'ready',
        pageCount: shared.pageCount ?? input.pageCount,
      });
      await scoped.recordCredit({
        delta: 0,
        reason: 'cache_hit',
        refId: document.id,
        metadata: {
          contentHash: input.contentHash,
          settingsHash: input.settingsHash,
          global: true,
        },
      });
      return { document, cached: true };
    }
  }

  // 3 — genuinely new bytes. Row first, then job: a job referencing a document
  // that does not exist yet is a worker crash, while a document with no job is
  // a retryable stuck state an operator can see.
  const document = await createDocument(scoped, input, {
    status: 'queued',
    pageCount: input.pageCount,
  });

  const job = await scoped.createJob({
    documentId: document.id,
    type: 'parse',
    payload: { settings: input.settings, storageKey: document.storageKey },
  });

  if (job) {
    await enqueueParseJob({
      jobId: job.id,
      orgId: input.orgId,
      documentId: document.id,
      storageKey: document.storageKey,
      contentHash: document.contentHash,
      settings: input.settings,
    });
  }

  // Charged against the monthly allowance at the moment the job is created,
  // because that is the last moment at which the number could still have
  // prevented a spend. Only for `advanced`: the standard tier costs the
  // operator's own CPU and there is nothing to meter. The route has already
  // refused a document the allowance would not cover — this is the record of
  // the one it did.
  if (input.settings.quality === 'advanced') {
    await recordEstimate(
      input.orgId,
      document.id,
      estimateFor(env, document.pageCount ?? input.pageCount ?? 0),
    );
  }

  return { document, cached: false };
}

async function createDocument(
  scoped: ReturnType<typeof scopedDb>,
  input: ResolveInput,
  overrides: { status: string; pageCount: number | null },
): Promise<DocumentRow> {
  const row = await scoped.createDocument({
    id: input.documentId,
    folderId: input.folderId ?? null,
    filename: input.filename,
    mime: input.mime,
    byteSize: input.byteSize,
    pageCount: overrides.pageCount,
    storageKey: input.storageKey,
    contentHash: input.contentHash,
    settingsHash: input.settingsHash,
    sourceUrl: input.sourceUrl ?? null,
    status: overrides.status,
  });

  if (!row) throw new Error('the document row could not be created');
  return row;
}

/**
 * Remove a document's objects from storage.
 *
 * Called after the row is gone, and after a cache hit makes a freshly-uploaded
 * object redundant. Failures are logged rather than raised: the caller has
 * already committed, and an orphaned blob is a cleanup job, not an error the
 * person who pressed delete can do anything about.
 */
export async function sweepDocumentObjects(orgId: string, documentId: string): Promise<void> {
  try {
    await storage().deletePrefix(documentPrefix(orgId, documentId));
  } catch (error) {
    console.error('[ingest] could not remove storage objects', { documentId }, error);
  }
}

/** Merge a partial settings object from a request onto the defaults. */
export function parseSettingsFrom(
  partial: { quality?: string; langList?: string[]; llm?: boolean } | undefined,
): ParseSettings {
  return ParseSettingsSchema.parse({ ...DEFAULT_PARSE_SETTINGS, ...(partial ?? {}) });
}

/** The wire shape of a document, used by every read endpoint and the library. */
export function presentDocument(row: DocumentRow, cached?: boolean): DocumentView {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    byteSize: row.byteSize,
    pageCount: row.pageCount,
    status: row.status,
    error: row.error,
    errorCode: row.errorCode,
    folderId: row.folderId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    // How much of the document is retrievable, and by what. On the wire because
    // a client cannot otherwise tell a document indexed with the current
    // embedding model from one that needs a reindex — and mixing two embedding
    // spaces in one search silently returns nonsense rather than failing.
    chunksReady: row.chunksReady,
    chunksTotal: row.chunksTotal,
    // In pages as well as in chunks: the progress UI divides by this, and a
    // reader who knows their filing is 900 pages long can estimate from "142
    // of 900" in a way they never could from a chunk count.
    pagesReady: row.pagesReady,
    pagesTotal: row.pagesTotal,
    embeddingModel: row.embeddingModel,
    dims: row.dims,
    ...(cached === undefined ? {} : { cached }),
  };
}
