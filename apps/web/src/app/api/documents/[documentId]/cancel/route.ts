import { withAuth } from '@/lib/auth/with-auth';
import { requestCancel } from '@/lib/ingest/cancel';
import { problemResponse } from '@/lib/ingest/errors';

/**
 * Stop an ingest that is still running.
 *
 * The endpoint behind the "Cancel Ingestion" button. It sets the cancellation
 * key the worker polls, marks the document `cancelled` so the library and the
 * viewer agree immediately, and publishes a final progress frame so a browser
 * watching the SSE stream sees the stop within the same second rather than
 * when the page currently being recognised finishes.
 *
 * Whatever had already been indexed stays indexed — a batched parse commits as
 * it goes — so a document cancelled at page 140 of 900 is a 140-page document
 * that can still be read and searched. That is the difference between
 * `cancelled` and `failed`, and it is why this is not a delete.
 *
 * `documents:write` rather than `documents:read`: it changes the document's
 * state and ends work that is being paid for.
 */
export const POST = withAuth<{ documentId: string }>(
  async (_request, auth, { params }) => {
    try {
      const { documentId } = await params;
      const result = await requestCancel({ orgId: auth.orgId, documentId });

      // 202: the request has been accepted and recorded, and the worker will
      // act on it at the next page boundary. Saying 200 would claim the
      // process had already stopped, which is not knowable from here.
      return Response.json(result, { status: 202, headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      return problemResponse(error);
    }
  },
  { scopes: ['documents:write'] },
);

export const dynamic = 'force-dynamic';
