import { withAuth } from '@/lib/auth/with-auth';
import { problemResponse } from '@/lib/ingest/errors';
import { requestReindex } from '@/lib/ingest/reindex';

/**
 * Rebuild a document's index without re-parsing it.
 *
 * The endpoint behind the acceptance criterion that switching `EMBEDDING_MODEL`
 * between a cloud and a local model needs only env changes plus a reindex. The
 * parse artifact is already in `parse_results`, keyed on the file's bytes and
 * its parse settings, so the job the worker picks up skips Docling entirely and
 * goes straight to chunking and embedding.
 *
 * `documents:write` rather than `documents:read`, because it spends credits and
 * replaces the index a search reads — it is a mutation of the document's state,
 * even though the document's bytes do not move.
 */
export const POST = withAuth<{ documentId: string }>(
  async (_request, auth, { params }) => {
    try {
      const { documentId } = await params;
      const job = await requestReindex({ orgId: auth.orgId, documentId });

      // 202: the work has been accepted, not done. The browser follows it on
      // the same SSE stream an upload uses — `/api/documents/:id/events` —
      // rather than polling this endpoint.
      return Response.json(job, { status: 202, headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      return problemResponse(error);
    }
  },
  { scopes: ['documents:write'] },
);

export const dynamic = 'force-dynamic';
