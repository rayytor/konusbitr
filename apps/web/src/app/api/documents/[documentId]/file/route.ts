import { scopedDb } from '@konusbitr/db';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';
import { IngestError, problemResponse } from '@/lib/ingest/errors';
import { storage } from '@/lib/storage';

/**
 * The original file, as a redirect.
 *
 * `GET /api/documents/:id` already returns a presigned download URL, but a
 * download control in a library of four thousand rows cannot presign four
 * thousand URLs up front — and a link that has to make a fetch, read JSON and
 * then navigate is a link that popup blockers treat as a popup. A stable
 * address that redirects is a link, and the bytes still never pass through
 * this process.
 */
const TTL_SECONDS = 5 * 60;

export const GET = withAuth<{ documentId: string }>(
  async (_request, auth, { params }) => {
    try {
      const { documentId } = await params;
      const row = await scopedDb(db(), auth.orgId).documentById(documentId);
      if (!row) throw IngestError.notFound('No document with that id.');

      const url = await storage().presignGet(row.storageKey, {
        expiresIn: TTL_SECONDS,
        downloadAs: row.filename,
      });

      return Response.redirect(url, 307);
    } catch (error) {
      return problemResponse(error);
    }
  },
  { scopes: ['documents:read'] },
);

export const dynamic = 'force-dynamic';
