import { PassThrough, Readable } from 'node:stream';
import { type DocumentRow, ID_PREFIXES, newId, scopedDb } from '@konusbitr/db';
import {
  isAnswerableDocumentStatus,
  type ParseSettings,
  sanitizeFilename,
  UPLOAD_KINDS,
} from '@konusbitr/shared';
import { originalKey } from '@konusbitr/storage';
import type { AuthContext } from '@/lib/auth/context';
import { db } from '@/lib/db';
import { loadWebEnv } from '@/lib/env';
import { parseSettingsFrom, presentDocument, resolveDocument } from '@/lib/ingest/documents';
import { inspectDocumentStream, settingsHash } from '@/lib/ingest/inspect';
import { fetchRemoteDocument, SsrfError } from '@/lib/ingest/ssrf';
import { assertAllowed } from '@/lib/ingest/vlm';
import { storage } from '@/lib/storage';
import { ApiError } from './errors';

/**
 * Turning `file` | `url` | `docId` into a document.
 *
 * Three ways in, one way out, and the mutual exclusivity is enforced here
 * rather than in each route: passing two of them is a 400 that names the
 * conflict, which is one of this phase's acceptance criteria and is exactly the
 * kind of rule that rots if four endpoints each implement it.
 *
 * `docId` is the path that matters commercially. It does no upload, no hashing
 * and no parse — it looks the document up and returns it — so a caller who
 * keeps their docIds pays for a document once and can `extract`, `ask` and
 * `split` against it forever. Everything else here exists to produce a docId
 * that behaves that way on the next call.
 */

const PDF = UPLOAD_KINDS[0];

export type ResolvedInput = {
  document: DocumentRow;
  /** True when no parse was run because one already existed for these bytes. */
  cached: boolean;
  /**
   * True when intake already wrote this hit to the ledger.
   *
   * An upload that turns out to be a repeat is recorded by `resolveDocument`,
   * which is the only place that knows it happened; a `docId` never goes
   * through intake, so nobody has. A route that writes its own `cache_hit` row
   * has to know which, or one free call becomes two ledger rows.
   */
  cacheHitRecorded: boolean;
  settings: ParseSettings;
};

type RawBody = Record<string, unknown>;

/** The uploaded part, when the request was `multipart/form-data`. */
export type UploadedFile = { stream: AsyncIterable<Uint8Array>; filename: string } | null;

/**
 * Refuse a request that names the document more than one way.
 *
 * Silently preferring one would be worse than a refusal: a caller who sends a
 * `url` alongside a stale `docId` would be told about a document they did not
 * ask about, and would have no way to notice.
 */
export function assertSingleInput(body: RawBody, file: UploadedFile): 'file' | 'url' | 'docId' {
  const given: string[] = [];
  if (file) given.push('file');
  if (typeof body.url === 'string' && body.url.length > 0) given.push('url');
  if (typeof body.docId === 'string' && body.docId.length > 0) given.push('docId');

  if (given.length > 1) {
    throw new ApiError(
      'input_conflict',
      `Give exactly one of file, url or docId; this request gave ${given.join(' and ')}.`,
      { given },
    );
  }
  if (given.length === 0) {
    throw new ApiError('input_missing', 'One of file, url or docId is required.', {
      expected: ['file', 'url', 'docId'],
    });
  }

  return given[0] as 'file' | 'url' | 'docId';
}

/** Look a `docId` up, or say clearly why it cannot be used. */
export async function resolveExistingDocument(
  auth: AuthContext,
  docId: string,
): Promise<DocumentRow> {
  const row = await scopedDb(db(), auth.orgId).documentById(docId);
  if (!row) {
    // The same answer for a foreign id and a nonexistent one, so no caller can
    // learn that a document exists in somebody else's organization.
    throw new ApiError('unknown_document', `No document ${docId} in this organization.`, { docId });
  }
  return row;
}

/**
 * Wait for a document to become usable, or explain why it never will.
 *
 * `partially_ready` counts as usable: Phase 12.4 made the first batch of a long
 * document answerable while the rest is still being read, and an API that
 * waited for the whole thing would be throwing away the property that was built
 * for. A caller who needs the whole document polls `GET /v2/documents/:docId`.
 */
export async function awaitDocumentReady(
  auth: AuthContext,
  documentId: string,
  options: { timeoutMs: number; requireComplete?: boolean },
): Promise<DocumentRow> {
  const scoped = scopedDb(db(), auth.orgId);
  const deadline = Date.now() + options.timeoutMs;
  // Polling rather than subscribing: the progress channel is a Redis pub/sub
  // whose only consumer is the browser's SSE endpoint, and an API call that is
  // already blocking for a parse is not the place to hold a second connection.
  const intervalMs = 500;

  for (;;) {
    const row = await scoped.documentById(documentId);
    if (!row) throw new ApiError('unknown_document', 'That document no longer exists.');

    if (row.status === 'ready') return row;
    if (!options.requireComplete && isAnswerableDocumentStatus(row.status)) return row;

    if (row.status === 'failed') {
      throw new ApiError(
        'document_failed',
        row.error ?? 'That document could not be processed.',
        row.errorCode ? { errorCode: row.errorCode } : undefined,
      );
    }
    if (row.status === 'cancelled') {
      throw new ApiError('document_failed', 'That document was cancelled before it finished.');
    }

    if (Date.now() >= deadline) {
      throw new ApiError(
        'document_not_ready',
        'That document is still being processed. Retry with ?async=true, or poll GET /v2/documents/:docId.',
        { docId: documentId, status: row.status },
      );
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Store and validate incoming bytes in one pass, then resolve them to a
 * document through the ordinary docId cache.
 *
 * The bytes are piped into object storage while they are being hashed and
 * checked, so a 200MB upload costs one part-sized buffer rather than 200MB of
 * heap — the same arrangement `POST /api/documents/from-url` uses, for the same
 * reason. A refusal at any point in the pass deletes the half-written object;
 * the key was derived from an id that never became a document, so there is
 * nothing to orphan.
 */
async function ingestBytes(
  auth: AuthContext,
  source: AsyncIterable<Uint8Array>,
  input: { filename: string; settings: ParseSettings; sourceUrl?: string | null },
): Promise<ResolvedInput> {
  const env = loadWebEnv();
  if (!PDF) throw new Error('the upload allowlist is empty');

  const documentId = newId(ID_PREFIXES.document);
  const storageKey = originalKey(auth.orgId, documentId, PDF.extension);

  try {
    const sink = new PassThrough();
    const uploading = storage().uploadStream(storageKey, sink, { contentType: PDF.mime });

    let inspection: Awaited<ReturnType<typeof inspectDocumentStream>>;
    try {
      inspection = await inspectDocumentStream(source, {
        maxBytes: env.MAX_UPLOAD_BYTES,
        maxPages: env.MAX_PAGES,
        onChunk: async (chunk) => {
          if (!sink.write(chunk)) {
            await new Promise<void>((resolve) => sink.once('drain', resolve));
          }
        },
      });
      sink.end();
      await uploading;
    } catch (error) {
      sink.destroy();
      await uploading.catch(() => undefined);
      throw error;
    }

    // The same ceilings the browser path applies, on the same settings: an API
    // key must not be a way around the organization's monthly vision cap.
    await assertAllowed(auth.orgId, env, input.settings, inspection.pageCount);

    const resolved = await resolveDocument({
      orgId: auth.orgId,
      documentId,
      storageKey,
      filename: sanitizeFilename(input.filename),
      mime: PDF.mime,
      byteSize: inspection.byteSize,
      pageCount: inspection.pageCount,
      contentHash: inspection.contentHash,
      settingsHash: settingsHash(input.settings),
      settings: input.settings,
      sourceUrl: input.sourceUrl ?? null,
    });

    // A cache hit makes the object we just wrote redundant — the document that
    // was returned points at bytes that are already stored.
    if (resolved.cached && resolved.document.storageKey !== storageKey) {
      await storage()
        .delete(storageKey)
        .catch(() => undefined);
    }

    return {
      document: resolved.document,
      cached: resolved.cached,
      cacheHitRecorded: resolved.cached,
      settings: input.settings,
    };
  } catch (error) {
    await storage()
      .delete(storageKey)
      .catch(() => undefined);
    throw error;
  }
}

/**
 * The whole of input resolution: pick the branch, produce a document.
 *
 * Returns as soon as the document row exists. Waiting for a parse to finish is
 * a separate decision made by the caller, because it is the one that differs
 * between the four endpoints — `parse` needs the artifact, `ask` needs an
 * index, and an `?async=true` request needs neither yet.
 */
export async function resolveInput(
  auth: AuthContext,
  body: RawBody,
  file: UploadedFile,
): Promise<ResolvedInput> {
  const which = assertSingleInput(body, file);
  const settings = parseSettingsFrom({
    quality: typeof body.quality === 'string' ? body.quality : undefined,
    langList: Array.isArray(body.lang_list) ? (body.lang_list as string[]) : undefined,
    llm: typeof body.llm === 'boolean' ? body.llm : undefined,
  });

  if (which === 'docId') {
    const document = await resolveExistingDocument(auth, String(body.docId));
    // A `docId` never re-parses, whatever settings came with it — that is the
    // contract, and it is why `docId` reuse is free. Settings on this branch
    // are advisory and are reported back as the document's own.
    return { document, cached: true, cacheHitRecorded: false, settings };
  }

  if (which === 'url') {
    const env = loadWebEnv();
    let remote: Awaited<ReturnType<typeof fetchRemoteDocument>>;
    try {
      remote = await fetchRemoteDocument(String(body.url), { maxBytes: env.MAX_UPLOAD_BYTES });
    } catch (error) {
      if (error instanceof SsrfError) {
        throw new ApiError('invalid_request', error.message, { reason: error.reason });
      }
      throw error;
    }

    const filename =
      (typeof body.filename === 'string' ? body.filename : undefined) ??
      remote.filename ??
      filenameFromUrl(remote.finalUrl);

    try {
      return await ingestBytes(auth, remote.body, {
        filename,
        settings,
        sourceUrl: remote.finalUrl,
      });
    } catch (error) {
      remote.cancel();
      throw error;
    }
  }

  if (!file) throw new ApiError('input_missing', 'One of file, url or docId is required.');
  return ingestBytes(auth, file.stream, { filename: file.filename, settings });
}

/** `https://example.com/docs/report.pdf?x=1` → `report.pdf`. */
function filenameFromUrl(raw: string): string {
  try {
    const last = new URL(raw).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'document.pdf';
  } catch {
    return 'document.pdf';
  }
}

/**
 * Pull the `file` part out of a `multipart/form-data` request, if there is one.
 *
 * `request.formData()` buffers, which is exactly what the streaming pass above
 * exists to avoid — but the `File` it hands back exposes a web `ReadableStream`
 * and the runtime keeps a large part backed by disk rather than by heap. The
 * ceiling that matters is still enforced by `inspectDocumentStream`, which
 * aborts the read the moment `MAX_UPLOAD_BYTES` is passed.
 */
export async function readMultipart(
  request: Request,
): Promise<{ body: RawBody; file: UploadedFile }> {
  const form = await request.formData();
  const body: RawBody = {};
  let file: UploadedFile = null;

  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      body[key] = coerceFormValue(key, value);
      continue;
    }
    if (key === 'file') {
      file = {
        stream: Readable.fromWeb(value.stream() as never) as AsyncIterable<Uint8Array>,
        filename: value.name || 'document.pdf',
      };
    }
  }

  return { body, file };
}

/**
 * Give a multipart field the type its JSON twin would have had.
 *
 * Every multipart value arrives as a string, so `llm=true` would fail a boolean
 * schema and `lang_list=["tr"]` would fail an array one — for a client that did
 * nothing wrong. The coercion is deliberately narrow: only the fields whose
 * documented type is not a string, and only shapes that are unambiguous.
 */
function coerceFormValue(key: string, value: string): unknown {
  if (key === 'llm') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }
  if (key === 'lang_list' || key === 'ranges' || key === 'docIds' || key === 'schema') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (key === 'level') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (key === 'corpus') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return value;
}

export { presentDocument };
