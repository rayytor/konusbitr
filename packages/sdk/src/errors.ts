import type { ApiError as ApiErrorBody } from './generated/types.js';

/**
 * Typed errors, so a caller can branch on what went wrong.
 *
 * The API returns one envelope for every failure with a code from a closed,
 * documented set, so the SDK's job is to turn that into something a `catch`
 * block can switch on rather than a string to match against. Hand-written
 * rather than generated: what a client *does* with a failure is not something
 * an OpenAPI document describes.
 */
export class KonusbitrError extends Error {
  override readonly name = 'KonusbitrError';

  constructor(
    /** A stable code from the API's documented set. */
    readonly code: string,
    message: string,
    readonly status: number,
    /** Machine-readable specifics: the conflicting fields, the missing scope. */
    readonly details: Record<string, unknown> | undefined,
    /** Matches the `X-Request-Id` header. Quote it in a bug report. */
    readonly requestId: string,
  ) {
    super(message);
  }

  static from(status: number, body: unknown, fallbackRequestId: string): KonusbitrError {
    const envelope = (body as ApiErrorBody | undefined)?.error;
    if (!envelope) {
      return new KonusbitrError(
        'internal',
        `The API returned ${status} with no error body.`,
        status,
        undefined,
        fallbackRequestId,
      );
    }
    return new KonusbitrError(
      envelope.code,
      envelope.message,
      status,
      envelope.details,
      envelope.requestId || fallbackRequestId,
    );
  }

  /** Whether trying the same request again could plausibly succeed. */
  get retryable(): boolean {
    if (this.status === 429) return true;
    return this.status >= 500;
  }
}

/** Raised when a rate limit is hit and the client is configured not to wait. */
export class RateLimitError extends KonusbitrError {
  /** Seconds the API asked the caller to wait, from `Retry-After`. */
  readonly retryAfterSeconds: number;

  constructor(base: KonusbitrError, retryAfterSeconds: number) {
    super(base.code, base.message, base.status, base.details, base.requestId);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Raised when an `?async=true` operation finishes in a failed state. */
export class JobFailedError extends KonusbitrError {
  constructor(
    readonly jobId: string,
    base: KonusbitrError,
  ) {
    super(base.code, base.message, base.status, base.details, base.requestId);
  }
}
