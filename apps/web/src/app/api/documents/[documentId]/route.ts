import { scopedDb } from '@konusbitr/db';
import { RenameDocumentRequestSchema, sanitizeFilename } from '@konusbitr/shared';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';
import { presentDocument, sweepDocumentObjects } from '@/lib/ingest/documents';
import { IngestError, problemResponse } from '@/lib/ingest/errors';
import { storage } from '@/lib/storage';

/**
 * One document: read it, or remove it entirely.
 *
 * Both handlers go through `scopedDb`, so a document belonging to another
 * organization is not "forbidden" — it is *absent*. That distinction is the
 * acceptance criterion: a 403 would confirm the id exists, and an attacker
 * enumerating ids would learn something from every request. A 404 tells them
 * nothing they did not already know.
 */

export const GET = withAuth<{ documentId: string }>(
  async (_request, auth, { params }) => {
    try {
      const { documentId } = await params;
      const row = await scopedDb(db(), auth.orgId).documentById(documentId);
      if (!row) throw IngestError.notFound('No document with that id.');

      // Presigned and short-lived: the viewer fetches the file straight from
      // storage, so the bytes never come back through here either.
      //
      // Two URLs for one object, because the `Content-Disposition` differs and
      // it is part of the signature. `viewUrl` is what PDF.js streams — an
      // `attachment` disposition would make some browsers offer a save dialog
      // instead of letting the range requests through — and `downloadUrl` is
      // what the toolbar's download control points at.
      const store = storage();
      const [viewUrl, downloadUrl] = await Promise.all([
        store.presignGet(row.storageKey, { expiresIn: 60 * 60, inlineAs: row.filename }),
        store.presignGet(row.storageKey, { expiresIn: 15 * 60, downloadAs: row.filename }),
      ]);

      return Response.json(
        { document: presentDocument(row), viewUrl, downloadUrl },
        { headers: { 'cache-control': 'no-store' } },
      );
    } catch (error) {
      return problemResponse(error);
    }
  },
  { scopes: ['documents:read'] },
);

/**
 * Rename a document.
 *
 * The filename is a *label* and always has been — the storage key is derived
 * from the generated document id, never from what the file was called — so a
 * rename touches one text column and nothing else. It still goes through
 * `sanitizeFilename`, because the new name is user input arriving by a
 * different door than the upload did.
 */
export const PATCH = withAuth<{ documentId: string }>(
  async (request, auth, { params }) => {
    try {
      const { documentId } = await params;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw IngestError.badRequest('invalid_json', 'Request body must be valid JSON.');
      }

      const parsed = RenameDocumentRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw IngestError.badRequest(
          'invalid_request',
          parsed.error.issues.map((issue) => issue.message).join(', '),
        );
      }

      const scoped = scopedDb(db(), auth.orgId);
      const row = await scoped.documentById(documentId);
      if (!row) throw IngestError.notFound('No document with that id.');

      const renamed = await scoped.renameDocument(
        documentId,
        sanitizeFilename(parsed.data.filename, row.filename),
      );
      if (!renamed) throw IngestError.notFound('No document with that id.');

      return Response.json(
        { document: presentDocument(renamed) },
        { headers: { 'cache-control': 'no-store' } },
      );
    } catch (error) {
      return problemResponse(error);
    }
  },
  { scopes: ['documents:write'] },
);

/**
 * Delete a document, its rows and its bytes.
 *
 * Pages, chunks, parse results and jobs are `ON DELETE CASCADE` from the
 * document, so the transaction in `deleteDocument` takes all of them together.
 * Storage is swept afterwards, deliberately: a blob left behind by a rolled-back
 * transaction can be reclaimed later, whereas a row pointing at bytes that were
 * already deleted is a document that renders as a broken page forever.
 */
export const DELETE = withAuth<{ documentId: string }>(
  async (_request, auth, { params }) => {
    try {
      const { documentId } = await params;
      const removed = await scopedDb(db(), auth.orgId).deleteDocument(documentId);
      if (!removed) throw IngestError.notFound('No document with that id.');

      await sweepDocumentObjects(auth.orgId, removed.id);

      return new Response(null, { status: 204 });
    } catch (error) {
      return problemResponse(error);
    }
  },
  { scopes: ['documents:write'] },
);

export const dynamic = 'force-dynamic';
