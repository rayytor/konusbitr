import { createId } from '@paralleldrive/cuid2';

/**
 * Generate a prefixed, collision-resistant, sortable-ish ID.
 *
 * Format: `prefix_<cuid2>` — readable in logs, safe in URLs, and unique
 * without coordination. Every table in Konusbitr uses this; raw UUIDs and
 * auto-incrementing integers are banned.
 *
 * @example
 * ```ts
 * newId('doc');  // "doc_clx1abc..."
 * newId('org');  // "org_clx1def..."
 * ```
 */
export function newId(prefix: string): string {
  return `${prefix}_${createId()}`;
}

/** Known ID prefixes used across the schema. */
export const ID_PREFIXES = {
  user: 'usr',
  session: 'ses',
  account: 'acc',
  verification: 'vrf',
  organization: 'org',
  membership: 'mem',
  invitation: 'inv',
  apiKey: 'key',
  folder: 'fld',
  document: 'doc',
  /** Not a table: the Redis-backed ticket that links a presigned PUT to a document. */
  upload: 'up',
  parseResult: 'prs',
  page: 'pag',
  chunk: 'chk',
  conversation: 'cnv',
  message: 'msg',
  extraction: 'ext',
  job: 'job',
  creditLedger: 'crl',
  documentEmbedding: 'demb',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];
