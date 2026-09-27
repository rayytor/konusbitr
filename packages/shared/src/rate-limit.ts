/**
 * The rate-limit contract: the headers, and what each one means.
 *
 * Two buckets are consulted on every `/v2` request — the API key's and the
 * organization's — because they stop different things. A per-key limit is what
 * keeps one runaway integration from consuming an organization's whole
 * allowance; a per-org limit is what the allowance actually *is*. A caller is
 * told about the tighter of the two, since that is the one they will hit.
 */

/** Requests allowed in the current window. */
export const RATE_LIMIT_LIMIT_HEADER = 'x-ratelimit-limit';

/** Requests left in it. */
export const RATE_LIMIT_REMAINING_HEADER = 'x-ratelimit-remaining';

/** Unix seconds at which the bucket will be full again. */
export const RATE_LIMIT_RESET_HEADER = 'x-ratelimit-reset';

/** Which bucket produced these numbers: `key` or `org`. */
export const RATE_LIMIT_SCOPE_HEADER = 'x-ratelimit-scope';

/** Seconds to wait. Sent only with a 429, per RFC 9110. */
export const RETRY_AFTER_HEADER = 'retry-after';

/** Which bucket a decision came from. */
export type RateLimitScope = 'key' | 'org';

export type RateLimitDecision = {
  allowed: boolean;
  scope: RateLimitScope;
  limit: number;
  remaining: number;
  /** Unix seconds at which a full bucket is next available. */
  resetAt: number;
  /** Seconds a refused caller should wait. At least 1, never 0. */
  retryAfterSeconds: number;
};

/**
 * The response headers for a decision.
 *
 * `Retry-After` only on a refusal: sending it on a successful request would
 * tell a well-behaved client to sleep when it has quota left.
 */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    [RATE_LIMIT_LIMIT_HEADER]: String(decision.limit),
    [RATE_LIMIT_REMAINING_HEADER]: String(Math.max(0, decision.remaining)),
    [RATE_LIMIT_RESET_HEADER]: String(decision.resetAt),
    [RATE_LIMIT_SCOPE_HEADER]: decision.scope,
  };
  if (!decision.allowed) {
    headers[RETRY_AFTER_HEADER] = String(Math.max(1, decision.retryAfterSeconds));
  }
  return headers;
}
