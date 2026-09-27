import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { scopedDb } from '@konusbitr/db';
import {
  formatWebhookSignature,
  parseWebhookSignature,
  WEBHOOK_ATTEMPT_HEADER,
  WEBHOOK_BACKOFF_MS,
  WEBHOOK_ID_HEADER,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  webhookSigningPayload,
} from '@konusbitr/shared';
import { db } from '@/lib/db';
import { loadWebEnv } from '@/lib/env';
import { parseIngestUrl, resolvePublicHost, SsrfError } from '@/lib/ingest/ssrf';
import { ApiError } from './errors';

/**
 * Calling a caller back, and the two things that makes dangerous.
 *
 * The first is that a `webhook_url` is a caller handing the server a
 * destination to make a request to. That is the same hazard as `POST
 * /v2/parse`'s `url` coming from the other direction, and it gets the same
 * guard: the URL is parsed, every address its hostname resolves to must be
 * public, and the vetted address is *pinned* into the socket so that a second
 * DNS answer cannot move the connection somewhere else after we approved it.
 *
 * The second is that a receiver has no way to know a POST came from us unless
 * we prove it. So every delivery is signed with HMAC-SHA256 over
 * `{timestamp}.{body}` — the timestamp inside the signed material, not merely
 * beside it, or a captured delivery could be replayed with any timestamp an
 * attacker liked.
 */

/**
 * Vet a hostname and return the address a connection should be pinned to.
 *
 * The default is Phase 05's guard, unchanged: every address the name resolves
 * to must be public, and the vetted one is pinned into the socket so a second
 * DNS answer cannot move the connection after we approved it.
 *
 * `WEBHOOK_ALLOW_PRIVATE_TARGETS` skips the classification and keeps the
 * pinning. It is off by default, and it exists because refusing private targets
 * outright is the wrong answer for a self-hoster whose receiver is on the same
 * Docker network — see the flag's note in `packages/shared/src/env.ts`. The
 * pinning is deliberately kept either way: it costs nothing and it is what
 * makes the address we resolved the address we talk to.
 */
async function vet(hostname: string): Promise<string> {
  if (!loadWebEnv().WEBHOOK_ALLOW_PRIVATE_TARGETS) return resolvePublicHost(hostname);

  const literal = hostname.replace(/^\[|\]$/g, '');
  if (/^[\d.]+$/.test(literal) || literal.includes(':')) return literal;

  try {
    const { address } = await dnsLookup(literal);
    return address;
  } catch {
    throw new SsrfError(`"${hostname}" could not be resolved.`, 'unresolvable');
  }
}

/** The key the HMAC is computed with. `AUTH_SECRET` is the documented fallback. */
function signingSecret(): string {
  const env = loadWebEnv();
  return env.WEBHOOK_SIGNING_SECRET ?? env.AUTH_SECRET;
}

export function signWebhook(body: string, timestampSeconds: number): string {
  const digest = createHmac('sha256', signingSecret())
    .update(webhookSigningPayload(timestampSeconds, body))
    .digest('hex');
  return formatWebhookSignature(digest);
}

/**
 * Check a signature the way a receiver should.
 *
 * Exported because it is the reference implementation the SDKs and the docs
 * point at, and because the test that proves the sender signs correctly has to
 * verify with something other than the sender.
 *
 * Constant-time, and the freshness window is checked *first*: comparing digests
 * on a delivery that is two days old tells an attacker how long a comparison
 * takes for nothing.
 */
export function verifyWebhook(
  body: string,
  headers: { signature?: string | null; timestamp?: string | null },
  options: { secret?: string; nowSeconds?: number } = {},
): boolean {
  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp)) return false;

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) return false;

  const presented = parseWebhookSignature(headers.signature);
  if (!presented) return false;

  const expected = createHmac('sha256', options.secret ?? signingSecret())
    .update(webhookSigningPayload(timestamp, body))
    .digest('hex');

  const a = Buffer.from(presented, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Vet a callback URL at request time and return it normalized.
 *
 * Done when the request arrives rather than when the delivery is attempted, so
 * a caller who typed `http://localhost:3000/hook` learns immediately instead of
 * receiving a job id for a notification that will never come. It is checked
 * again at delivery — DNS moves, and minutes can pass — which is why this
 * returns the URL rather than the address it resolved to.
 */
export async function assertWebhookUrl(raw: string): Promise<string> {
  let url: URL;
  try {
    url = parseIngestUrl(raw);
  } catch (error) {
    const message = error instanceof SsrfError ? error.message : 'That is not a usable URL.';
    throw new ApiError('invalid_webhook_url', message);
  }

  try {
    await vet(url.hostname);
  } catch (error) {
    const message =
      error instanceof SsrfError ? error.message : 'That webhook URL could not be resolved.';
    throw new ApiError('invalid_webhook_url', message);
  }

  return url.toString();
}

type DeliveryOutcome = { ok: boolean; status: number | null; detail?: string };

/** One POST, to an address that has just been vetted, with no redirects followed. */
function post(
  url: URL,
  pinnedAddress: string,
  body: string,
  headers: Record<string, string>,
): Promise<DeliveryOutcome> {
  return new Promise((resolve) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

    const req = send(
      url,
      {
        method: 'POST',
        // The vetted address, pinned, exactly as the import path does it: Node
        // calls this instead of resolving the hostname a second time, so there
        // is no second DNS answer for a rebinding attack to change.
        lookup: (_hostname, options, callback) => {
          const family = pinnedAddress.includes(':') ? 6 : 4;
          if (typeof options === 'object' && options.all) {
            callback(null, [{ address: pinnedAddress, family }] as never);
            return;
          }
          callback(null, pinnedAddress as never, family);
        },
        headers: {
          ...headers,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'user-agent': 'Konusbitr-Webhook/0.0',
        },
        timeout: WEBHOOK_TIMEOUT_MS,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        // The body is drained and discarded. A receiver's response content is
        // of no interest to us, and leaving it unread keeps the socket open.
        response.resume();
        response.on('end', () => resolve({ ok: status >= 200 && status < 300, status }));
      },
    );

    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (error) => resolve({ ok: false, status: null, detail: error.message }));
    req.end(body);
  });
}

/**
 * Deliver a finished job to its webhook, retrying a few times.
 *
 * Four attempts over about half a minute, then given up on — deliberately
 * short. The same body is durably available at `GET /v2/jobs/:jobId`, so a
 * webhook is a notification and not the only copy, and retrying for hours to
 * reach a receiver that is down would be spending our budget on their outage.
 *
 * Failures are recorded on the row and never raised: this runs after the
 * operation itself has finished, and a job that succeeded must not be reported
 * as failed because somebody's endpoint returned a 500.
 */
export async function deliverWebhook(input: {
  orgId: string;
  jobId: string;
  url: string;
  body: unknown;
}): Promise<void> {
  const scoped = scopedDb(db(), input.orgId);
  const payload = JSON.stringify(input.body);
  let last: DeliveryOutcome = { ok: false, status: null, detail: 'not attempted' };

  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const backoff = WEBHOOK_BACKOFF_MS[attempt - 2] ?? WEBHOOK_BACKOFF_MS.at(-1) ?? 1_000;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }

    try {
      const url = parseIngestUrl(input.url);
      // Re-vetted on every attempt: the first check was at request time, and a
      // name that was public then can point inward by the time we call it.
      const pinned = await vet(url.hostname);
      const timestamp = Math.floor(Date.now() / 1000);

      last = await post(url, pinned, payload, {
        [WEBHOOK_SIGNATURE_HEADER]: signWebhook(payload, timestamp),
        [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
        [WEBHOOK_ID_HEADER]: input.jobId,
        [WEBHOOK_ATTEMPT_HEADER]: String(attempt),
      });
    } catch (error) {
      last = {
        ok: false,
        status: null,
        detail: error instanceof Error ? error.message : 'unknown error',
      };
      // An SSRF refusal is terminal: the destination is not one we will call,
      // and trying again in five seconds will reach the same conclusion.
      if (error instanceof SsrfError) {
        await scoped
          .updateApiJob(input.jobId, { webhookAttempts: attempt, webhookStatus: 'refused' })
          .catch(() => undefined);
        return;
      }
    }

    if (last.ok) {
      await scoped
        .updateApiJob(input.jobId, { webhookAttempts: attempt, webhookStatus: 'delivered' })
        .catch(() => undefined);
      return;
    }
  }

  console.warn('[v2] webhook gave up', {
    jobId: input.jobId,
    status: last.status,
    detail: last.detail,
  });
  await scoped
    .updateApiJob(input.jobId, {
      webhookAttempts: WEBHOOK_MAX_ATTEMPTS,
      webhookStatus: `failed:${last.status ?? 'unreachable'}`,
    })
    .catch(() => undefined);
}
