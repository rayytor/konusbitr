import {
  type Env,
  type RateLimitDecision,
  type RateLimitScope,
  rateLimitHeaders,
} from '@konusbitr/shared';
import type { AuthContext } from '@/lib/auth/context';
import { redis } from '@/lib/redis';

/**
 * A Redis token bucket, consulted twice per request.
 *
 * A bucket rather than a fixed window because a window has an edge: with sixty
 * requests a minute and a window that resets on the minute, a client can send
 * sixty at 10:00:59 and sixty more at 10:01:00 and be inside the limit while
 * having sent a hundred and twenty in a second. A bucket refills continuously,
 * so the limit is the limit at every instant.
 *
 * The whole decision is one Lua script, which is what makes it correct under
 * concurrency: read, refill, test and decrement have to happen without another
 * request interleaving, and three round trips from Node cannot promise that.
 */

/** Refill and take, atomically. Returns `{ allowed, remaining, resetAtMs }`. */
const TAKE = `
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill   = tonumber(ARGV[2])   -- tokens per millisecond
local now      = tonumber(ARGV[3])
local cost     = tonumber(ARGV[4])
local ttl      = tonumber(ARGV[5])

local bucket = redis.call('HMGET', key, 'tokens', 'at')
local tokens = tonumber(bucket[1])
local at     = tonumber(bucket[2])

if tokens == nil or at == nil then
  tokens = capacity
  at = now
end

-- Refill for the time that has passed, capped at the bucket's capacity. A
-- clock that went backwards is treated as no elapsed time rather than as a
-- negative refill, which would silently drain every bucket on the instance.
local elapsed = math.max(0, now - at)
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
end

redis.call('HSET', key, 'tokens', tokens, 'at', now)
redis.call('PEXPIRE', key, ttl)

-- When the next whole token arrives, for Retry-After.
local deficit = math.max(0, cost - tokens)
local waitMs = 0
if allowed == 0 and refill > 0 then
  waitMs = math.ceil(deficit / refill)
end

-- When the bucket would be full again, for X-RateLimit-Reset.
local fullMs = 0
if refill > 0 then
  fullMs = math.ceil((capacity - tokens) / refill)
end

return { allowed, math.floor(tokens), waitMs, fullMs }
`;

type BucketSpec = { scope: RateLimitScope; key: string; capacity: number };

/**
 * An allowed decision for a limiter that is switched off.
 *
 * `RATE_LIMIT_ENABLED=false` means *not consulted*, not "a very large limit" —
 * so the headers report the disabled state honestly rather than inventing a
 * number a client would pace itself against.
 */
function unlimited(): RateLimitDecision {
  return {
    allowed: true,
    scope: 'org',
    limit: 0,
    remaining: 0,
    resetAt: Math.ceil(Date.now() / 1000),
    retryAfterSeconds: 0,
  };
}

async function take(spec: BucketSpec, now: number): Promise<RateLimitDecision> {
  const windowMs = 60_000;
  const refillPerMs = spec.capacity / windowMs;
  // Twice the window: long enough that a bucket surviving between a client's
  // bursts is the normal case, short enough that idle keys do not accumulate.
  const ttlMs = windowMs * 2;

  const raw = (await redis().eval(
    TAKE,
    1,
    spec.key,
    String(spec.capacity),
    String(refillPerMs),
    String(now),
    '1',
    String(ttlMs),
  )) as [number, number, number, number];

  const [allowed, remaining, waitMs, fullMs] = raw;

  return {
    allowed: allowed === 1,
    scope: spec.scope,
    limit: spec.capacity,
    remaining,
    resetAt: Math.ceil((now + fullMs) / 1000),
    retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
  };
}

/**
 * Consult both buckets and return the decision the caller will actually feel.
 *
 * Both are debited on an allowed request, which is why they are taken before
 * either result is inspected: charging only the bucket that happened to be
 * checked first would let a client with a generous per-key limit sail past the
 * organization's. On a refusal the *refusing* bucket is reported, because that
 * is the one whose numbers explain the 429.
 *
 * A principal with no API key — a browser session hitting `/v2` — has only the
 * organization bucket. There is no per-key limit to apply, and inventing one
 * keyed on the user would rate-limit the product's own UI.
 */
export async function checkRateLimit(
  auth: AuthContext,
  env: Env,
): Promise<{ decision: RateLimitDecision; headers: Record<string, string> }> {
  if (!env.RATE_LIMIT_ENABLED) {
    const decision = unlimited();
    return { decision, headers: rateLimitHeaders(decision) };
  }

  const now = Date.now();
  const specs: BucketSpec[] = [
    {
      scope: 'org',
      key: `ratelimit:org:${auth.orgId}`,
      capacity: env.RATE_LIMIT_PER_ORG_PER_MINUTE,
    },
  ];
  if (auth.apiKeyId) {
    specs.unshift({
      scope: 'key',
      key: `ratelimit:key:${auth.apiKeyId}`,
      capacity: env.RATE_LIMIT_PER_KEY_PER_MINUTE,
    });
  }

  const decisions = await Promise.all(specs.map((spec) => take(spec, now)));

  // The refusing bucket if there is one; otherwise the tightest, since that is
  // the number a well-behaved client should be pacing itself against.
  const refused = decisions.find((decision) => !decision.allowed);
  const decision =
    refused ??
    decisions.reduce((tightest, candidate) =>
      candidate.remaining < tightest.remaining ? candidate : tightest,
    );

  if (!decision) return { decision: unlimited(), headers: {} };
  return { decision, headers: rateLimitHeaders(decision) };
}
