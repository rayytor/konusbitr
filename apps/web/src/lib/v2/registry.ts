import type { ApiErrorCode, ApiJobKind } from '@konusbitr/shared';
import type { ZodType } from 'zod';
import type { ApiScope } from '@/lib/auth/scopes';

/**
 * The route table, and the reason it exists.
 *
 * The phase requires an OpenAPI document that *cannot* drift from the code, and
 * the only way to get that is for the description and the implementation to
 * read from one object. So a route is declared here — its path, its Zod request
 * schema, its Zod response schema, the scope it needs — and two things consume
 * the declaration: `mount.ts`, which turns it into a Hono handler that
 * validates with those very schemas, and `openapi.ts`, which turns it into
 * OpenAPI 3.1 through Zod's own JSON Schema conversion.
 *
 * A route that is implemented but not declared is unreachable, and one that is
 * declared but not implemented fails to mount, so "the spec describes an
 * endpoint that does not exist" is not a state this can be in.
 */

export type RouteBodyKind =
  /** `application/json` only. */
  | 'json'
  /** `application/json` *or* `multipart/form-data` carrying a `file` part. */
  | 'json-or-multipart'
  /** No request body. */
  | 'none';

export type RouteDefinition = {
  method: 'get' | 'post' | 'delete';
  /** Hono-style path, e.g. `/documents/:docId`. */
  path: string;
  operationId: string;
  summary: string;
  description: string;
  /** Scopes an API key must hold. Session principals hold all of them. */
  scopes: readonly ApiScope[];
  body: RouteBodyKind;
  /** Validates the request body. Absent for `body: 'none'`. */
  request?: ZodType;
  /** Validates and documents the success body. */
  response: ZodType;
  /** HTTP status of the success response. */
  status?: number;
  /** Path parameters, in order, each with a one-line description. */
  params?: readonly { name: string; description: string }[];
  /**
   * The job kind recorded when this endpoint is called with `?async=true`, or
   * absent on an endpoint that is always synchronous.
   *
   * Declared rather than inferred from the operation id, so the OpenAPI
   * document lists the parameter and the `202` response on exactly the
   * operations that have them, and so that renaming an operation cannot
   * silently change what a stored job row says it was.
   */
  async?: ApiJobKind;
  /**
   * Failure codes this operation can return, beyond the ones every route
   * shares (`unauthorized`, `missing_scope`, `rate_limited`, `internal`).
   *
   * Listed so the generated document enumerates real statuses rather than a
   * blanket "default: error", which is what makes a contract test per
   * documented error case possible at all.
   */
  errors: readonly ApiErrorCode[];
};

/** Codes any `/v2` route can return, contributed by the middleware chain. */
export const UNIVERSAL_ERROR_CODES = [
  'unauthorized',
  'missing_scope',
  'rate_limited',
  'internal',
] as const satisfies readonly ApiErrorCode[];

/** Codes any endpoint that takes `file`/`url`/`docId` can return. */
export const DOCUMENT_INPUT_ERROR_CODES = [
  'input_conflict',
  'input_missing',
  'invalid_json',
  'invalid_request',
  'unknown_document',
  'document_not_ready',
  'document_failed',
  'too_large',
  'unsupported_media_type',
  'invalid_document',
  'encrypted_document',
  'needs_ocr',
  'too_many_pages',
  'insufficient_credits',
  'invalid_webhook_url',
] as const satisfies readonly ApiErrorCode[];
