/**
 * A distributed token bucket, backed by Redis.
 *
 * Konusbitr rate-limits the endpoints that an attacker can call without an
 * account: login, signup, magic link and invite-accept. A counter in process
 * memory would be defeated by running two web containers, so the state lives in
 * the Redis that Phase 02 already requires.
 *
 * The bucket is refilled lazily and checked atomically in one Lua script.
 * Reading the count, deciding, then writing it back would let N concurrent
 * requests all pass the same stale read — exactly the burst a limiter exists to
 * stop.
 */

export type RateLimitRule = {
  /** Width of the window, in seconds. */
  window: number;
  /** Requests allowed per window. Also the bucket's capacity. */
  max: number;
};

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds until the next token, or `null` when the request was allowed. */
  retryAfter: number | null;
};

export interface RateLimiter {
  consume(key: string, rule: RateLimitRule): Promise<RateLimitResult>;
}

/** Minimal surface of the Redis client this needs, so tests can supply a fake. */
export interface RateLimitRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * KEYS[1] bucket, ARGV = capacity, refill-per-second, now (ms), ttl (s).
 *
 * Returns `{ allowed, retryAfterSeconds }`. The bucket stores its token count
 * and the millisecond it was last refilled; both expire once a full bucket's
 * worth of time has passed, so idle keys cost nothing.
 */
const CONSUME_SCRIPT = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(bucket[1])
local at = tonumber(bucket[2])

if tokens == nil or at == nil then
  tokens = capacity
  at = now
end

local elapsed = math.max(0, now - at) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
local retry = 0

if tokens >= 1 then
  allowed = 1
  tokens = tokens - 1
else
  retry = math.ceil((1 - tokens) / refill)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'at', now)
redis.call('EXPIRE', KEYS[1], ttl)

return { allowed, retry }
`;

function toResult(raw: unknown): RateLimitResult {
  const [allowed, retry] = Array.isArray(raw) ? raw : [0, 1];
  return Number(allowed) === 1
    ? { allowed: true, retryAfter: null }
    : { allowed: false, retryAfter: Math.max(1, Number(retry) || 1) };
}

/** A limiter backed by Redis. This is what runs in production. */
export function createRedisRateLimiter(redis: RateLimitRedis): RateLimiter {
  return {
    async consume(key, rule) {
      const refill = rule.max / rule.window;
      const raw = await redis.eval(
        CONSUME_SCRIPT,
        1,
        key,
        rule.max,
        refill,
        Date.now(),
        Math.ceil(rule.window * 2),
      );
      return toResult(raw);
    },
  };
}

/**
 * An in-process limiter with the same semantics, for tests and for a
 * single-instance deployment that has chosen not to run Redis.
 *
 * It is not a substitute for the Redis one: two web containers each get their
 * own buckets, so the effective limit doubles.
 */
export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, { tokens: number; at: number }>();

  return {
    async consume(key, rule) {
      const refill = rule.max / rule.window;
      const timestamp = now();
      const bucket = buckets.get(key) ?? { tokens: rule.max, at: timestamp };

      const elapsed = Math.max(0, timestamp - bucket.at) / 1000;
      let tokens = Math.min(rule.max, bucket.tokens + elapsed * refill);

      let result: RateLimitResult;
      if (tokens >= 1) {
        tokens -= 1;
        result = { allowed: true, retryAfter: null };
      } else {
        result = { allowed: false, retryAfter: Math.max(1, Math.ceil((1 - tokens) / refill)) };
      }

      buckets.set(key, { tokens, at: timestamp });
      return result;
    },
  };
}
