import { describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  isRetryableStatus,
  ModelCallError,
  withResilience,
} from '../src/resilience.js';

const noSleep = () => Promise.resolve();

describe('isRetryableStatus', () => {
  it('retries a rate limit and a gateway error', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });

  it('does not retry a bad request or a rejected credential', () => {
    // Retrying either is pure latency: the request will be just as wrong.
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe('withResilience', () => {
  it('returns the first success without sleeping', async () => {
    const sleep = vi.fn(noSleep);
    const result = await withResilience(
      { role: 'embedding', attempts: 3, sleep },
      async () => 'ok',
    );

    expect(result).toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a retryable failure up to the attempt budget', async () => {
    const call = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new ModelCallError('429', { role: 'embedding', retryable: true }))
      .mockRejectedValueOnce(new ModelCallError('429', { role: 'embedding', retryable: true }))
      .mockResolvedValue('ok');

    await expect(
      withResilience({ role: 'embedding', attempts: 3, sleep: noSleep }, call),
    ).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('spends no attempt on a failure that will not improve', async () => {
    const call = vi
      .fn()
      .mockRejectedValue(new ModelCallError('401', { role: 'embedding', retryable: false }));

    await expect(
      withResilience({ role: 'embedding', attempts: 3, sleep: noSleep }, call),
    ).rejects.toThrow('401');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially with full jitter', async () => {
    const waits: number[] = [];
    const call = vi
      .fn()
      .mockRejectedValue(new ModelCallError('429', { role: 'embedding', retryable: true }));

    await expect(
      withResilience(
        {
          role: 'embedding',
          attempts: 4,
          baseDelayMs: 100,
          // `random` pinned to its maximum, so the assertion is about the
          // exponential and not about the draw.
          random: () => 1,
          sleep: async (ms) => void waits.push(ms),
        },
        call,
      ),
    ).rejects.toThrow();

    expect(waits).toEqual([100, 200, 400]);
  });

  it('draws the delay from [0, exponential] rather than jittering around it', async () => {
    const waits: number[] = [];
    await expect(
      withResilience(
        {
          role: 'embedding',
          attempts: 2,
          baseDelayMs: 800,
          random: () => 0,
          sleep: async (ms) => void waits.push(ms),
        },
        async () => {
          throw new ModelCallError('429', { role: 'embedding', retryable: true });
        },
      ),
    ).rejects.toThrow();

    expect(waits).toEqual([0]);
  });
});

describe('CircuitBreaker', () => {
  it('counts three attempts against one provider as one failure', async () => {
    // The distinction that stops a queue of a hundred documents from
    // discovering one outage a hundred times: the breaker is consulted before
    // the first attempt and updated after the last.
    const breaker = new CircuitBreaker({ failures: 2, cooldownMs: 1_000, now: () => 0 });

    const fail = () =>
      withResilience({ role: 'embedding', attempts: 3, breaker, sleep: noSleep }, async () => {
        throw new ModelCallError('503', { role: 'embedding', retryable: true });
      });

    await expect(fail()).rejects.toThrow();
    expect(breaker.state).toBe('closed');

    await expect(fail()).rejects.toThrow();
    expect(breaker.state).toBe('open');
  });

  it('refuses calls instantly while open', async () => {
    const breaker = new CircuitBreaker({ failures: 1, cooldownMs: 10_000, now: () => 0 });
    breaker.recordFailure();

    const call = vi.fn();
    await expect(
      withResilience({ role: 'embedding', attempts: 3, breaker, sleep: noSleep }, call),
    ).rejects.toThrow(CircuitOpenError);
    expect(call).not.toHaveBeenCalled();
  });

  it('lets exactly one call through after the cooldown, and re-opens on failure', async () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ failures: 1, cooldownMs: 100, now: () => clock });
    breaker.recordFailure();
    expect(breaker.state).toBe('open');

    clock = 150;
    // Half-open: the counter is not reset, so a single further failure opens
    // it again rather than granting a fresh budget to a dead provider.
    await expect(
      withResilience({ role: 'embedding', attempts: 1, breaker, sleep: noSleep }, async () => {
        throw new ModelCallError('503', { role: 'embedding', retryable: true });
      }),
    ).rejects.toThrow(ModelCallError);
    expect(breaker.state).toBe('open');
  });

  it('closes for good on a success', async () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ failures: 1, cooldownMs: 100, now: () => clock });
    breaker.recordFailure();
    clock = 150;

    await expect(
      withResilience({ role: 'embedding', attempts: 1, breaker, sleep: noSleep }, async () => 'ok'),
    ).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
  });

  it('does not open on requests that were simply wrong', async () => {
    // Five malformed calls must not take a working provider offline.
    const breaker = new CircuitBreaker({ failures: 2, cooldownMs: 1_000, now: () => 0 });

    for (let i = 0; i < 5; i += 1) {
      await expect(
        withResilience({ role: 'embedding', attempts: 3, breaker, sleep: noSleep }, async () => {
          throw new ModelCallError('400', { role: 'embedding', retryable: false });
        }),
      ).rejects.toThrow();
    }

    expect(breaker.state).toBe('closed');
  });
});
