import { CompleteUploadRequestSchema } from '@konusbitr/shared';
import { withAuth } from '@/lib/auth/with-auth';
import { IngestError, problemResponse } from '@/lib/ingest/errors';
import { readTicket, saveTicket } from '@/lib/ingest/tickets';
import { storage } from '@/lib/storage';

/**
 * Assemble the parts of a multipart upload.
 *
 * S3 needs the ETag it returned for every part before it will stitch them into
 * one object, and only the browser has them — it did the PUTs. So this exists
 * as its own call: the client reports the ETags, the server completes the
 * upload with credentials the client never sees, and `POST /api/documents` can
 * then treat the object as it would any other.
 *
 * Nothing here trusts the part list beyond its shape. A wrong ETag makes S3
 * refuse the completion, which is exactly the check that matters.
 */
export const POST = withAuth(
  async (request, auth) => {
    try {
      const parsed = CompleteUploadRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        throw IngestError.badRequest(
          'invalid_request',
          'An upload id and the uploaded parts are required.',
        );
      }

      const ticket = await readTicket(parsed.data.uploadId, auth.orgId);

      if (ticket.strategy !== 'multipart' || !ticket.multipartUploadId) {
        throw IngestError.badRequest(
          'not_multipart',
          'That upload was a single PUT; there is nothing to assemble.',
        );
      }

      // Completing twice is not an error worth surfacing — a client that
      // retried a request whose response it never saw should get the same
      // answer, not a failure.
      if (!ticket.completed) {
        await storage().completeMultipart(
          ticket.storageKey,
          ticket.multipartUploadId,
          parsed.data.parts,
        );
        await saveTicket({ ...ticket, completed: true });
      }

      return Response.json(
        { uploadId: ticket.uploadId, completed: true },
        { headers: { 'cache-control': 'no-store' } },
      );
    } catch (error) {
      return problemResponse(error);
    }
  },
  { scopes: ['documents:write'] },
);

export const dynamic = 'force-dynamic';
