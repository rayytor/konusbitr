import { ID_PREFIXES, newId } from '@konusbitr/db';
import {
  PresignRequestSchema,
  sanitizeFilename,
  uploadKindForFilename,
  uploadKindForMime,
} from '@konusbitr/shared';
import { MULTIPART_THRESHOLD_BYTES, originalKey } from '@konusbitr/storage';
import { withAuth } from '@/lib/auth/with-auth';
import { loadWebEnv } from '@/lib/env';
import { IngestError, problemResponse } from '@/lib/ingest/errors';
import { formatBytes } from '@/lib/ingest/inspect';
import { saveTicket, TICKET_TTL_SECONDS } from '@/lib/ingest/tickets';
import { storage } from '@/lib/storage';

/**
 * Ask for somewhere to put a file.
 *
 * This is the endpoint that keeps 500MB out of the web process. It hands back a
 * URL — one PUT for a small file, one per part for a large one — and the
 * browser talks to object storage directly from there. Nothing about the bytes
 * passes through Next.js.
 *
 * Two things the client sends are checked here and neither is trusted later:
 * the declared MIME type picks the extension for the storage key, and the
 * declared size picks single versus multipart. Both are re-checked against
 * reality (`HEAD`, then a full read) before a document is created.
 */
export const POST = withAuth(
  async (request, auth) => {
    try {
      const parsed = PresignRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        throw IngestError.badRequest(
          'invalid_request',
          'A filename, a MIME type and a byte size are required.',
        );
      }

      const env = loadWebEnv();
      const { filename, mimeType, byteSize } = parsed.data;

      // The declared type decides; the filename's suffix is the fallback for
      // the browsers and CLIs that send `application/octet-stream`.
      const kind = uploadKindForMime(mimeType) ?? uploadKindForFilename(filename);
      if (!kind) {
        throw IngestError.unsupportedMedia(
          'unsupported_media_type',
          'Konusbitr reads PDFs today. Other formats are coming.',
        );
      }

      if (byteSize > env.MAX_UPLOAD_BYTES) {
        throw IngestError.tooLarge(
          `That file is larger than the ${formatBytes(env.MAX_UPLOAD_BYTES)} upload limit.`,
        );
      }

      // The document id exists before the bytes do, because the storage key is
      // derived from it. Nothing in the key comes from the filename.
      const documentId = newId(ID_PREFIXES.document);
      const storageKey = originalKey(auth.orgId, documentId, kind.extension);
      const uploadId = newId(ID_PREFIXES.upload);

      const multipart = byteSize > MULTIPART_THRESHOLD_BYTES;

      if (multipart) {
        const ticket = await storage().presignMultipart(storageKey, byteSize, {
          contentType: kind.mime,
        });

        await saveTicket({
          uploadId,
          orgId: auth.orgId,
          documentId,
          storageKey,
          filename: sanitizeFilename(filename),
          mime: kind.mime,
          declaredBytes: byteSize,
          strategy: 'multipart',
          multipartUploadId: ticket.uploadId,
          completed: false,
          createdAt: Date.now(),
        });

        return Response.json(
          {
            uploadId,
            strategy: 'multipart',
            partSize: ticket.partSize,
            parts: ticket.parts,
            expiresIn: TICKET_TTL_SECONDS,
          },
          { status: 201, headers: { 'cache-control': 'no-store' } },
        );
      }

      const url = await storage().presignPut(storageKey, { contentType: kind.mime });

      await saveTicket({
        uploadId,
        orgId: auth.orgId,
        documentId,
        storageKey,
        filename: sanitizeFilename(filename),
        mime: kind.mime,
        declaredBytes: byteSize,
        strategy: 'single',
        completed: false,
        createdAt: Date.now(),
      });

      return Response.json(
        { uploadId, strategy: 'single', url, expiresIn: TICKET_TTL_SECONDS },
        { status: 201, headers: { 'cache-control': 'no-store' } },
      );
    } catch (error) {
      return problemResponse(error);
    }
  },
  { scopes: ['documents:write'] },
);

export const dynamic = 'force-dynamic';
