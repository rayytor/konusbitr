import { scopedDb } from '@konusbitr/db';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';
import { IngestError, problemResponse } from '@/lib/ingest/errors';
import { storage } from '@/lib/storage';

/**
 * One page's thumbnail, as a redirect.
 *
 * A redirect rather than a proxy, because the rule that image bytes never pass
 * through the Next.js server is the same rule that keeps a 500MB upload cheap:
 * this handler does one indexed row read and one HMAC, and the browser fetches
 * the WebP straight from storage.
 *
 * `<img src>` follows a 302 without any JavaScript, which is why the library
 * grid can use it directly and why this is a redirect rather than JSON holding
 * a URL.
 */
const TTL_SECONDS = 10 * 60;

export const GET = withAuth<{ documentId: string }>(
  async (request, auth, { params }) => {
    try {
      const { documentId } = await params;
      const requested = new URL(request.url).searchParams.get('page') ?? '1';
      const page = Number.parseInt(requested, 10);
      if (!Number.isInteger(page) || page < 1) {
        throw IngestError.badRequest('invalid_page', 'page must be a positive integer.');
      }

      const scoped = scopedDb(db(), auth.orgId);
      const row = await scoped.pageByNumber(documentId, page);

      // Absent and not-yet-rendered are the same answer on purpose: a document
      // mid-parse has rows for the pages it has reached and nothing for the
      // rest, and the rail treats both as "no image yet".
      if (!row?.thumbnailKey) throw IngestError.notFound('No thumbnail for that page.');

      const url = await storage().presignGet(row.thumbnailKey, { expiresIn: TTL_SECONDS });

      return new Response(null, {
        status: 307,
        headers: {
          Location: url,
          'Cache-Control': 'private, max-age=300',
        },
      });
    } catch (error) {
      return problemResponse(error);
    }
  },
  { scopes: ['documents:read'] },
);

export const dynamic = 'force-dynamic';
