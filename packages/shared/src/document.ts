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
  /**
   * Some of the document is indexed and the rest is still being read.
   *
   * Not a decoration on `embedding`: it is the status that says the viewer may
   * open the file and chat may answer over it. A 900-page filing takes a
   * quarter of an hour to read end to end, and making somebody wait all of it
   * before their first question — when the answer is on page four and page
   * four has been indexed for fourteen minutes — is the whole reason this
   * status exists.
   *
   * Not terminal: the document is still moving, and a client watching it must
   * keep its progress stream open.
   */
  'partially_ready',
  'ready',
  'failed',
  /**
   * Stopped by the person who uploaded it, not by anything going wrong.
   *
   * Terminal, and kept distinct from `failed` because a library that badges a
   * deliberate cancellation in red is telling its reader something untrue.
   */
  'cancelled',
] as const;

export const DocumentStatusSchema = z.enum(DOCUMENT_STATUSES);

export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

/** Statuses from which no further progress events are expected. */
export const TERMINAL_DOCUMENT_STATUSES = [
  'ready',
  'failed',
  'cancelled',
] as const satisfies readonly DocumentStatus[];

export function isTerminalDocumentStatus(status: DocumentStatus): boolean {
  return (TERMINAL_DOCUMENT_STATUSES as readonly DocumentStatus[]).includes(status);
}

/**
 * Statuses from which a document can be searched and chatted with.
 *
 * `partially_ready` is in the list on purpose — that is what it is for — and
 * the honesty of it rests on the chunks: a chunk exists only once the page it
 * came from has been read, so an answer over a partially-ready document is
 * grounded in pages that really have been parsed, and the citations it carries
 * verify against real page text exactly as they would at the end.
 */
export const ANSWERABLE_DOCUMENT_STATUSES = [
  'partially_ready',
  'ready',
] as const satisfies readonly DocumentStatus[];

export function isAnswerableDocumentStatus(status: string): boolean {
  return (ANSWERABLE_DOCUMENT_STATUSES as readonly string[]).includes(status);
}
