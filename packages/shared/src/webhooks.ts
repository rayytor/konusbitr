/**
 * The webhook contract: what we send, how it is signed, and how a receiver
 * checks it.
 *
 * Constants and the canonical signing string live here so that the sender, the
 * documentation, both SDKs and anybody writing a receiver read the same
 * definition. The HMAC itself is computed where there is a crypto
 * implementation — this package deliberately imports no Node built-ins so it
 * can be imported anywhere, including a browser bundle.
 */

/** Hex-encoded HMAC-SHA256 over the signed payload, prefixed with its version. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-konusbitr-signature';

/** Unix seconds at which the request was signed. Part of the signed payload. */
export const WEBHOOK_TIMESTAMP_HEADER = 'x-konusbitr-timestamp';

/** The async job the delivery is about, so a receiver can be idempotent. */
export const WEBHOOK_ID_HEADER = 'x-konusbitr-webhook-id';

/** Which attempt this is, 1-based. */
export const WEBHOOK_ATTEMPT_HEADER = 'x-konusbitr-attempt';

/** Version prefix on the signature, so the scheme can change without ambiguity. */
export const WEBHOOK_SIGNATURE_VERSION = 'v1';

/**
 * How far out of date a timestamp may be before a receiver should refuse it.
 *
 * Five minutes. The timestamp is inside the signed payload precisely so that a
 * captured delivery cannot be replayed indefinitely; without a freshness window
 * on the receiving side the signature proves origin but not recency.
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/**
 * Deliveries, first included, and the backoff between them.
 *
 * Four attempts over about two minutes. Short on purpose: the body is also
 * durably available at `GET /v2/jobs/:jobId`, so a webhook is a notification
 * rather than the only copy, and retrying for hours to deliver something the
 * caller can fetch would be spending our retry budget on their downtime.
 */
export const WEBHOOK_MAX_ATTEMPTS = 4;

export const WEBHOOK_BACKOFF_MS: readonly number[] = Object.freeze([1_000, 5_000, 25_000]);

/** A receiver's response is given this long before the attempt counts as failed. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Exactly what the HMAC is computed over: `{timestamp}.{body}`.
 *
 * The timestamp is joined into the signed material rather than merely sent
 * alongside it. Signing the body alone would let an attacker who captured one
 * delivery replay it with any timestamp they liked, which defeats the point of
 * having one.
 */
export function webhookSigningPayload(timestampSeconds: number, body: string): string {
  return `${timestampSeconds}.${body}`;
}

/** The header value for a computed digest: `v1=<hex>`. */
export function formatWebhookSignature(hexDigest: string): string {
  return `${WEBHOOK_SIGNATURE_VERSION}=${hexDigest}`;
}

/** The hex digest out of a `v1=<hex>` header, or `null` if it is not one. */
export function parseWebhookSignature(header: string | null | undefined): string | null {
  if (!header) return null;
  const [version, digest] = header.trim().split('=', 2);
  if (version !== WEBHOOK_SIGNATURE_VERSION || !digest) return null;
  return /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}
