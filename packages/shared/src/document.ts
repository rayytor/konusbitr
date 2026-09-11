import { z } from 'zod';

/**
 * Lifecycle of a document from upload to queryable.
 *
 * `failed` is terminal; `ready` is terminal until the document is reparsed with
 * different {@link ParseSettings}.
 */
export const DOCUMENT_STATUSES = [
  'queued',
  'parsing',
  'ocr',
  'embedding',
  'ready',
  'failed',
] as const;

export const DocumentStatusSchema = z.enum(DOCUMENT_STATUSES);

export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

/** Statuses from which no further progress events are expected. */
export const TERMINAL_DOCUMENT_STATUSES = [
  'ready',
  'failed',
] as const satisfies readonly DocumentStatus[];

export function isTerminalDocumentStatus(status: DocumentStatus): boolean {
  return (TERMINAL_DOCUMENT_STATUSES as readonly DocumentStatus[]).includes(status);
}
