import { describe, expect, it } from 'vitest';
import { createMemoryRateLimiter } from '@/lib/auth/rate-limit';

/**
 * The in-memory limiter is the reference implementation of the semantics; the
 * Lua script that runs in Redis is asserted against a real Redis in
 * `test/integration/auth.integration.test.ts`.
 */
describe('token bucket', () => {
  it('allows exactly `max` requests in a cold window', async () => {
    const limiter = createMemoryRateLimiter(() => 0);
    const rule = { window: 60, max: 3 };

    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await limiter.consume('user', rule));

    expect(results.map((result) => result.allowed)).toEqual([true, true, true, false, false]);
  });

  it('reports when the next token arrives', async () => {
    const limiter = createMemoryRateLimiter(() => 0);
    const rule = { window: 60, max: 1 };

    expect((await limiter.consume('user', rule)).retryAfter).toBeNull();

    // One token per 60s, so the next one is a minute out.
    const denied = await limiter.consume('user', rule);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBe(60);
  });

  it('refills as time passes', async () => {
    let now = 0;
    const limiter = createMemoryRateLimiter(() => now);
    const rule = { window: 10, max: 2 };

    await limiter.consume('user', rule);
    await limiter.consume('user', rule);
    expect((await limiter.consume('user', rule)).allowed).toBe(false);

    // Two per ten seconds means one token every five.
    now += 5_000;
    expect((await limiter.consume('user', rule)).allowed).toBe(true);
    expect((await limiter.consume('user', rule)).allowed).toBe(false);
  });

  it("never refills past the bucket's capacity", async () => {
    let now = 0;
    const limiter = createMemoryRateLimiter(() => now);
    const rule = { window: 10, max: 2 };

    await limiter.consume('user', rule);
    now += 60 * 60 * 1000;

    // An hour of idling does not buy a burst larger than the bucket.
    expect((await limiter.consume('user', rule)).allowed).toBe(true);
    expect((await limiter.consume('user', rule)).allowed).toBe(true);
    expect((await limiter.consume('user', rule)).allowed).toBe(false);
  });

  it("keeps one caller's budget away from another's", async () => {
    const limiter = createMemoryRateLimiter(() => 0);
    const rule = { window: 60, max: 1 };

    expect((await limiter.consume('alice', rule)).allowed).toBe(true);
    expect((await limiter.consume('alice', rule)).allowed).toBe(false);
    expect((await limiter.consume('bob', rule)).allowed).toBe(true);
  });
});
