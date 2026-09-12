import { PassThrough } from 'node:stream';
import { ID_PREFIXES, newId, scopedDb } from '@konusbitr/db';
import { CreateFromUrlRequestSchema, sanitizeFilename, UPLOAD_KINDS } from '@konusbitr/shared';
import { originalKey } from '@konusbitr/storage';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';
import { loadWebEnv } from '@/lib/env';
import { parseSettingsFrom, presentDocument, resolveDocument } from '@/lib/ingest/documents';
import { IngestError, problemResponse } from '@/lib/ingest/errors';
import { inspectDocumentStream, settingsHash } from '@/lib/ingest/inspect';
import { fetchRemoteDocument, SsrfError } from '@/lib/ingest/ssrf';
import { storage } from '@/lib/storage';

/**
 * Import a document from a URL.
 *
 * This endpoint hands a caller the ability to make the server issue a request,
 * which is why the guard in `lib/ingest/ssrf.ts` exists and why every refusal
 * it raises is turned into a 400 here rather than being allowed to look like an
 * internal error. Read that module before changing anything in this one.
 *
 * The bytes do pass through the app on this path — there is no browser to
 * presign for — but they are never *held*: the response is piped into object
 * storage while it is being hashed and validated, so importing 200MB costs one
 * part-sized buffer, not 200MB.
 */

const PDF = UPLOAD_KINDS[0];

export const POST = withAuth(
  async (request, auth) => {
    const env = loadWebEnv();
    let storageKey: string | undefined;

    try {
      const parsed = CreateFromUrlRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        throw IngestError.badRequest('invalid_request', 'A URL is required.');
      }
      if (!PDF) throw new Error('the upload allowlist is empty');

      const scoped = scopedDb(db(), auth.orgId);
      if (parsed.data.folderId && !(await scoped.folderById(parsed.data.folderId))) {
        throw IngestError.badRequest('unknown_folder', 'That folder does not exist.');
      }

      const documentId = newId(ID_PREFIXES.document);
      storageKey = originalKey(auth.orgId, documentId, PDF.extension);

      const remote = await fetchRemoteDocument(parsed.data.url, {
        maxBytes: env.MAX_UPLOAD_BYTES,
      });

      const filename = sanitizeFilename(
        parsed.data.filename ?? remote.filename ?? filenameFromUrl(remote.finalUrl),
      );

      // One pass over the response: into storage, into the hash, and through
      // the validator. A file that turns out not to be a PDF, or to be a bomb,
      // fails here — and the half-written object is removed below.
      const sink = new PassThrough();
      const uploading = storage().uploadStream(storageKey, sink, { contentType: PDF.mime });

      let inspection: Awaited<ReturnType<typeof inspectDocumentStream>>;
      try {
        inspection = await inspectDocumentStream(remote.body, {
          maxBytes: env.MAX_UPLOAD_BYTES,
          maxPages: env.MAX_PAGES,
          onChunk: async (chunk) => {
            // Respect the upload's backpressure rather than buffering the whole
            // download in front of it.
            if (!sink.write(chunk)) {
              await new Promise<void>((resolve) => sink.once('drain', resolve));
            }
          },
        });
        sink.end();
        await uploading;
      } catch (error) {
        remote.cancel();
        sink.destroy();
        await uploading.catch(() => undefined);
        throw error;
      }

      const settings = parseSettingsFrom(parsed.data.settings);

      const resolved = await resolveDocument({
        orgId: auth.orgId,
        documentId,
        storageKey,
        filename,
        mime: PDF.mime,
        byteSize: inspection.byteSize,
        pageCount: inspection.pageCount,
        contentHash: inspection.contentHash,
        settingsHash: settingsHash(settings),
        settings,
        folderId: parsed.data.folderId ?? null,
        sourceUrl: remote.finalUrl,
      });

      if (resolved.cached && resolved.document.storageKey !== storageKey) {
        await storage().delete(storageKey);
      }

      return Response.json(
        { document: presentDocument(resolved.document, resolved.cached) },
        { status: resolved.cached ? 200 : 201, headers: { 'cache-control': 'no-store' } },
      );
    } catch (error) {
      // Nothing partial survives a refusal. The key was derived from an id that
      // never became a document, so there is no row to orphan.
      if (storageKey)
        await storage()
          .delete(storageKey)
          .catch(() => undefined);

      if (error instanceof SsrfError) {
        return problemResponse(
          IngestError.badRequest(`url_${error.reason.replace(/-/g, '_')}`, error.message),
        );
      }
      return problemResponse(error);
    }
  },
  { scopes: ['documents:write'] },
);

/** `https://example.com/docs/report.pdf?x=1` → `report.pdf`. */
function filenameFromUrl(raw: string): string {
  try {
    const last = new URL(raw).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'document.pdf';
  } catch {
    return 'document.pdf';
  }
}

export const dynamic = 'force-dynamic';
