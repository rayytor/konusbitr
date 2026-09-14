import { scopedDb } from '@konusbitr/db';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';
import { IngestError, problemResponse } from '@/lib/ingest/errors';

/**
 * The geometry of a document's pages.
 *
 * The viewer needs this before it can draw a single citation. A bbox arrives in
 * PDF points on the *visible* page (`docs/coordinates.md`), so turning it into
 * a rectangle is `renderedWidthPx / page.width` — and the viewer has to know
 * `page.width` from something other than the PDF it is still downloading.
 *
 * `hasThumbnail` rather than a presigned URL per page: a 500-page document
 * would otherwise mean 500 signatures in one response, most of them for pages
 * the rail will never scroll to. The rail asks `…/thumbnail?page=n` for the
 * handful it actually shows.
 *
 * `tier` and `ocrConfidence` say how a page's text was obtained. A reader is
 * entitled to know that a quoted sentence came out of a recogniser rather than
 * out of a font, because those two claims deserve different amounts of trust —
 * and the viewer cannot tell them apart from the bounding boxes alone.
 */
export const GET = withAuth<{ documentId: string }>(
  async (_request, auth, { params }) => {
    try {
      const { documentId } = await params;
      const scoped = scopedDb(db(), auth.orgId);

      const document = await scoped.documentById(documentId);
      if (!document) throw IngestError.notFound('No document with that id.');

      const rows = await scoped.listPages(documentId);

      return Response.json(
        {
          documentId,
          pageCount: document.pageCount,
          pages: rows.map((row) => ({
            page: row.pageNo,
            width: row.width,
            height: row.height,
            hasThumbnail: row.thumbnailKey !== null,
            tier: row.tier,
            ocrConfidence: row.ocrConfidence,
          })),
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    } catch (error) {
      return problemResponse(error);
    }
  },
  { scopes: ['documents:read'] },
);

export const dynamic = 'force-dynamic';
