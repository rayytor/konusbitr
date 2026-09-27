import { API_ERROR_STATUS, type ApiErrorCode } from '@konusbitr/shared';
import { IngestError } from '@/lib/ingest/errors';

/**
 * One error type for the whole `/v2` surface, and one place it becomes a
 * response.
 *
 * The phase asks for "one error envelope everywhere, with documented, stable
 * codes and correct HTTP statuses", and the only way three things stay in step
 * is for one of them to determine the others. So the code is the input and the
 * status is looked up from {@link API_ERROR_STATUS} rather than passed: a route
 * cannot return a 404 for `invalid_request` even by accident, because it never
 * writes a number.
 *
 * `details` is for machine-readable specifics — which field conflicted, which
 * scope was missing, how many pages the document has — and never for anything
 * derived from document text. The message is written for a person and is the
 * only part that a caller should not parse.
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  get status(): number {
    return API_ERROR_STATUS[this.code];
  }

  /** The envelope body, once a request id is known. */
  body(requestId: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        requestId,
      },
    };
  }

  static badRequest(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError('invalid_request', message, details);
  }

  static notFound(message = 'No such resource.'): ApiError {
    return new ApiError('not_found', message);
  }
}

/**
 * Map the intake pipeline's refusals onto this surface's codes.
 *
 * `lib/ingest` predates the `/v2` API and is shared with the web app, so its
 * errors carry Phase 05's vocabulary. Translating them here — rather than
 * widening `ApiErrorCode` to whatever intake happens to raise — is what keeps
 * the published code list a closed set a client can switch on. Anything
 * unrecognised becomes `invalid_request` with its original code in `details`,
 * so a new intake refusal degrades to an accurate 400 rather than a 500.
 */
const INGEST_CODE_MAP: Readonly<Record<string, ApiErrorCode>> = Object.freeze({
  invalid_request: 'invalid_request',
  not_found: 'not_found',
  too_large: 'too_large',
  unsupported_type: 'unsupported_media_type',
  mime_mismatch: 'unsupported_media_type',
  not_a_pdf: 'invalid_document',
  corrupt_document: 'invalid_document',
  encrypted_pdf: 'encrypted_document',
  encrypted_document: 'encrypted_document',
  too_many_pages: 'too_many_pages',
  needs_ocr: 'needs_ocr',
  unknown_folder: 'invalid_request',
  vlm_cap_exceeded: 'insufficient_credits',
});

export function fromIngestError(error: IngestError): ApiError {
  const mapped = INGEST_CODE_MAP[error.code];
  if (mapped) return new ApiError(mapped, error.message, error.extra);

  // Preserve the status class the intake path chose even when the code is one
  // this surface has never heard of: a 413 that arrived as an unmapped code is
  // still a 413-shaped problem, and reporting it as a 400 would send a client
  // looking at its request body instead of its file size.
  const byStatus: ApiErrorCode =
    error.status === 404
      ? 'not_found'
      : error.status === 413
        ? 'too_large'
        : error.status === 415
          ? 'unsupported_media_type'
          : error.status === 422
            ? 'invalid_document'
            : 'invalid_request';

  return new ApiError(byStatus, error.message, { ...error.extra, ingestCode: error.code });
}

/** Anything thrown anywhere under `/v2`, as an {@link ApiError}. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof IngestError) return fromIngestError(error);

  // Unrecognised is a bug, not a caller mistake. The detail goes to the log;
  // the caller gets a sentence, because an exception message from deep in the
  // stack can carry things a caller must not see — a connection string, a
  // provider key, a fragment of somebody's document.
  console.error('[v2] unhandled error', error);
  return new ApiError('internal', 'Something went wrong handling that request.');
}
