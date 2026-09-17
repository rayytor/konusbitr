import { scopedDb } from '@konusbitr/db';
import { CreateDocumentRequestSchema } from '@konusbitr/shared';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';
import { loadWebEnv } from '@/lib/env';
import { parseSettingsFrom, presentDocument, resolveDocument } from '@/lib/ingest/documents';
import { IngestError, problemResponse } from '@/lib/ingest/errors';
import { formatBytes, inspectDocumentStream, settingsHash } from '@/lib/ingest/inspect';
import { discardTicket, readTicket } from '@/lib/ingest/tickets';
import { assertAllowed } from '@/lib/ingest/vlm';
import { storage } from '@/lib/storage';

/**
 * The library, and the door into it.
 *
 * `POST` is where the docId cache is decided. By the time it runs the bytes are
 * already in object storage — the browser put them there — so its job is to
 * confirm they are what was claimed, learn what they hash to, and then either
 * hand back a document that already exists or create one and enqueue a parse.
 *
 * The one expensive step, a full streaming read of the object, is also the only
 * honest way to do any of that: a `content_hash` that trusted the client would
 * let anyone poison the cache for their own organization, and a MIME type that
 * trusted the client would hand the parser a ZIP.
 */

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export const GET = withAuth(
  async (request, auth) =>
    problemOr(async () => {
      const url = new URL(request.url);
      const scoped = scopedDb(db(), auth.orgId);

      const requested = Number(url.searchParams.get('limit') ?? DEFAULT_PAGE_SIZE);
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(Math.trunc(requested), 1), MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;

      const cursor = url.searchParams.get('cursor');
      const folder = url.searchParams.get('folderId');

      // One row beyond the page, so "is there more" needs no second query.
      const rows = await scoped.listDocuments({
        limit: limit + 1,
        ...(cursor ? { before: decodeCursor(cursor) } : {}),
        ...(folder === null ? {} : { folderId: folder === 'none' ? null : folder }),
      });

      const page = rows.slice(0, limit);
      const last = page.at(-1);

      return Response.json(
        {
          documents: page.map((row) => presentDocument(row)),
          nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    }),
  { scopes: ['documents:read'] },
);

/** Encodes the keyset cursor so a client cannot hand us an arbitrary predicate. */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { createdAt: Date; id: string } {
  const [timestamp, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(timestamp ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) {
    throw IngestError.badRequest('invalid_cursor', 'That page cursor is not valid.');
  }
  return { createdAt, id };
}

async function problemOr(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    return problemResponse(error);
  }
}

export const POST = withAuth(
  async (request, auth) =>
    problemOr(async () => {
      const parsed = CreateDocumentRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        throw IngestError.badRequest('invalid_request', 'An upload id is required.');
      }

      const env = loadWebEnv();
      const scoped = scopedDb(db(), auth.orgId);
      const ticket = await readTicket(parsed.data.uploadId, auth.orgId);

      if (parsed.data.folderId && !(await scoped.folderById(parsed.data.folderId))) {
        throw IngestError.badRequest('unknown_folder', 'That folder does not exist.');
      }

      // Did the upload actually happen, and is it the size the client said?
      const head = await storage().head(ticket.storageKey);
      if (!head) {
        throw IngestError.badRequest(
          'upload_missing',
          'That upload never arrived in storage. Upload the file again.',
        );
      }
      if (head.byteSize !== ticket.declaredBytes) {
        await storage().delete(ticket.storageKey);
        await discardTicket(ticket.uploadId);
        throw IngestError.badRequest(
          'upload_incomplete',
          'That upload is a different size than was declared, so it did not finish. Upload the file again.',
        );
      }
      if (head.byteSize > env.MAX_UPLOAD_BYTES) {
        await storage().delete(ticket.storageKey);
        await discardTicket(ticket.uploadId);
        throw IngestError.tooLarge(
          `That file is larger than the ${formatBytes(env.MAX_UPLOAD_BYTES)} upload limit.`,
        );
      }

      const settings = parseSettingsFrom(parsed.data.settings);

      // One streaming pass: hash, sniff, and refuse anything a parser should
      // not be handed. A refusal means the object does not stay.
      let inspection: Awaited<ReturnType<typeof inspectDocumentStream>>;
      try {
        inspection = await inspectDocumentStream(await storage().streamGet(ticket.storageKey), {
          maxBytes: env.MAX_UPLOAD_BYTES,
          maxPages: env.MAX_PAGES,
        });
      } catch (error) {
        await storage().delete(ticket.storageKey);
        await discardTicket(ticket.uploadId);
        throw error;
      }

      // Before anything is created: an `advanced` request this instance cannot
      // serve, or one that would run past the page ceiling or the monthly cap,
      // is refused here. The object stays — the bytes are fine and the same
      // upload can be resubmitted at standard quality without a second transfer.
      await assertAllowed(auth.orgId, env, settings, inspection.pageCount);

      const resolved = await resolveDocument({
        orgId: auth.orgId,
        documentId: ticket.documentId,
        storageKey: ticket.storageKey,
        filename: ticket.filename,
        mime: ticket.mime,
        byteSize: inspection.byteSize,
        pageCount: inspection.pageCount,
        contentHash: inspection.contentHash,
        settingsHash: settingsHash(settings),
        settings,
        folderId: parsed.data.folderId ?? null,
      });

      await discardTicket(ticket.uploadId);

      // A cache hit means these bytes are already in storage under the document
      // that won, so the copy just uploaded is redundant and is removed.
      if (resolved.cached && resolved.document.storageKey !== ticket.storageKey) {
        await storage().delete(ticket.storageKey);
      }

      return Response.json(
        { document: presentDocument(resolved.document, resolved.cached) },
        {
          status: resolved.cached ? 200 : 201,
          headers: { 'cache-control': 'no-store' },
        },
      );
    }),
  { scopes: ['documents:write'] },
);

export const dynamic = 'force-dynamic';
