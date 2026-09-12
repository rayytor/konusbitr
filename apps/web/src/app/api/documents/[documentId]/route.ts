import { scopedDb } from '@konusbitr/db';
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
      const downloadUrl = await storage().presignGet(row.storageKey, {
        expiresIn: 15 * 60,
        downloadAs: row.filename,
      });

      return Response.json(
        { document: presentDocument(row), downloadUrl },
        { headers: { 'cache-control': 'no-store' } },
      );
    } catch (error) {
      return problemResponse(error);
    }
  },
  { scopes: ['documents:read'] },
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
