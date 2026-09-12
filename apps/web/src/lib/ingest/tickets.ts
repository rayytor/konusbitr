import { z } from 'zod';
import { redis } from '../redis';
import { IngestError } from './errors';

/**
 * What the server remembers between presigning an upload and being told it
 * finished.
 *
 * The browser is handed an `uploadId` and a URL; when it comes back with
 * `POST /api/documents` it says only "the thing you called `up_…` is there".
 * Everything that decides what happens next — which organization it belongs to,
 * which key it landed on, what size and type were declared — is read from here
 * rather than from the request, because a client that could name its own
 * storage key or its own organization would be a tenancy hole rather than an
 * API.
 *
 * Redis rather than a table: the record is short-lived, write-once and useless
 * once the document exists, and Phase 02 already requires Redis. The TTL is the
 * feature — an upload that is presigned and abandoned expires on its own and
 * leaves no row to clean up.
 */

const TICKET_PREFIX = 'upload:ticket:';

/**
 * How long a presigned upload stays claimable.
 *
 * Slightly longer than the presigned URLs themselves so that a client which
 * finishes a slow upload just before its URLs expire can still claim it, and
 * short enough that an abandoned ticket does not linger for a day.
 */
export const TICKET_TTL_SECONDS = 2 * 60 * 60;

export const UploadTicketSchema = z.object({
  uploadId: z.string().min(1),
  orgId: z.string().min(1),
  /** Reserved at presign time so the storage key is derived from a real id. */
  documentId: z.string().min(1),
  storageKey: z.string().min(1),
  filename: z.string().min(1),
  mime: z.string().min(1),
  /** What the client said the file weighs. Checked against `HEAD` before use. */
  declaredBytes: z.number().int().positive(),
  strategy: z.enum(['single', 'multipart']),
  /** S3's own multipart id, present only while a multipart upload is open. */
  multipartUploadId: z.string().optional(),
  /** Set once the parts have been assembled, so a ticket cannot be completed twice. */
  completed: z.boolean().default(false),
  createdAt: z.number().int(),
});

export type UploadTicket = z.infer<typeof UploadTicketSchema>;

function key(uploadId: string): string {
  return `${TICKET_PREFIX}${uploadId}`;
}

export async function saveTicket(ticket: UploadTicket): Promise<void> {
  await redis().set(key(ticket.uploadId), JSON.stringify(ticket), 'EX', TICKET_TTL_SECONDS);
}

/**
 * Read a ticket back, refusing one that belongs to another organization.
 *
 * The org check is why a guessed `uploadId` is worthless: it resolves to the
 * same "we do not have that upload" as a nonexistent one, so nothing is learned
 * either way.
 */
export async function readTicket(uploadId: string, orgId: string): Promise<UploadTicket> {
  const raw = await redis().get(key(uploadId));
  if (!raw) {
    throw IngestError.notFound(
      'That upload has expired or was never started. Upload the file again.',
    );
  }

  const parsed = UploadTicketSchema.safeParse(JSON.parse(raw));
  if (!parsed.success || parsed.data.orgId !== orgId) {
    throw IngestError.notFound(
      'That upload has expired or was never started. Upload the file again.',
    );
  }

  return parsed.data;
}

/** Drop a ticket once it has produced a document, or when it is abandoned. */
export async function discardTicket(uploadId: string): Promise<void> {
  await redis().del(key(uploadId));
}
