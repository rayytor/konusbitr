import type { ModelRole } from '@konusbitr/shared';

/**
 * Retries, backoff and a circuit breaker, around one model call.
 *
 * Three failure shapes, three different right answers.
 *
 * A 429 or a 503 is the provider asking for a moment: retry with exponential
 * backoff and jitter. Jitter is not decoration — a worker embedding a
 * 500-page document in batches will hit a rate limit on many batches at once,
 * and a fixed backoff synchronises them into a thundering herd that hits the
 * same limit again in lockstep.
 *
 * A 400 or a 401 is the request or the credential being wrong: retrying is
 * pure latency, so it fails immediately and says which.
 *
 * A provider that is *down* is the case a breaker exists for. Without one, a
 * dead endpoint turns every job into `max_retries × timeout` of waiting before
 * it fails, and a queue of a hundred documents spends an hour discovering the
 * same outage a hundred times. After `MODEL_BREAKER_FAILURES` consecutive
 * failures the circuit opens and calls fail instantly for the cooldown, then
 * one call is let through to find out whether it is back.
 */

/** A model call that failed in a way worth naming. */
export class ModelCallError extends Error {
  override readonly name = 'ModelCallError';

  constructor(
    message: string,
    readonly options: {
      readonly role: ModelRole;
      readonly status?: number;
      readonly retryable: boolean;
      readonly cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
  }

  get retryable(): boolean {
    return this.options.retryable;
  }
}

/** Raised while a role's circuit is open. Never retried: that is the point. */
export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError';

  constructor(
    readonly role: ModelRole,
    readonly reopensInMs: number,
  ) {
    super(
      `The ${role} provider has failed repeatedly; calls are being refused for ` +
        `another ${Math.ceil(reopensInMs / 1000)}s. Fix the provider rather than ` +
        'waiting out one timeout per job.',
    );
  }
}

/**
 * Status codes worth trying again.
 *
 * 408 and 409 are in because some OpenAI-compatible servers (vLLM under load,
 * Ollama while a model is still loading) use them for "busy, come back", and
 * 499 because a proxy in front of a slow local model can close the connection
 * before the model has finished loading on first use.
 */
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 499, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

export type BreakerOptions = {
  /** Consecutive failures that open the circuit. */
  failures: number;
  /** How long it stays open. */
  cooldownMs: number;
  /** Injected in tests; `Date.now` in production. */
  now?: () => number;
};

/**
 * One breaker per role.
 *
 * Per role rather than per process because the roles fail independently: a
 * deployment with a cloud chat model and local embeddings has two providers,
 * and an OpenAI outage must not stop the worker from embedding.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | undefined;

  constructor(private readonly options: BreakerOptions) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Raise if the circuit is open and its cooldown has not elapsed. */
  assertClosed(role: ModelRole): void {
    if (this.openedAt === undefined) return;

    const elapsed = this.now - this.openedAt;
    if (elapsed < this.options.cooldownMs) {
      throw new CircuitOpenError(role, this.options.cooldownMs - elapsed);
    }

    // Half-open: let exactly one call through. The counter is left where it is,
    // so a single further failure re-opens immediately rather than granting a
    // fresh budget of attempts to a provider that is still down.
    this.openedAt = undefined;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.failures) {
      this.openedAt = this.now;
    }
  }

  /** For `/health`, and for the tests. */
  get state(): 'closed' | 'open' {
    if (this.openedAt === undefined) return 'closed';
    return this.now - this.openedAt < this.options.cooldownMs ? 'open' : 'closed';
  }
}

export type RetryOptions = {
  role: ModelRole;
  /** Attempts including the first. */
  attempts: number;
  breaker?: CircuitBreaker;
  /** Base delay; attempt *n* waits `base * 2 ** (n - 1)` plus jitter. */
  baseDelayMs?: number;
  /** Injected in tests so a retry test does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; `Math.random` in production. */
  random?: () => number;
};

const DEFAULT_BASE_DELAY_MS = 500;

function delayFor(attempt: number, baseMs: number, random: () => number): number {
  const exponential = baseMs * 2 ** (attempt - 1);
  // Full jitter: a uniform draw from [0, exponential] rather than
  // exponential ± a little. It is what keeps a batch of simultaneous rate
  // limits from retrying in lockstep.
  return Math.round(exponential * random());
}

/**
 * Run a model call with retries, backoff and the role's breaker.
 *
 * The breaker is consulted before the first attempt and updated after the last,
 * not per attempt: three attempts against one dead provider are one failure of
 * that provider, and counting them separately would open the circuit on the
 * first job rather than the fifth.
 */
export async function withResilience<T>(
  options: RetryOptions,
  call: (attempt: number) => Promise<T>,
): Promise<T> {
  const {
    role,
    attempts,
    breaker,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  breaker?.assertClosed(role);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await call(attempt);
      breaker?.recordSuccess();
      return result;
    } catch (error) {
      lastError = error;

      const retryable = error instanceof ModelCallError ? error.retryable : true;
      if (!retryable) {
        // A bad request or a rejected credential is not evidence that the
        // provider is unhealthy, so it must not count towards the breaker:
        // otherwise five malformed calls would take a working provider offline.
        throw error;
      }

      if (attempt === attempts) break;
      await sleep(delayFor(attempt, baseDelayMs, random));
    }
  }

  breaker?.recordFailure();
  throw lastError;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
