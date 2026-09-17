import { parseEnv } from '@konusbitr/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The advanced tier's guardrails, on the side a person can see.
 *
 * Three refusals live here, and all three exist because the alternative is
 * somebody discovering an advanced parse's cost after it has happened. What
 * makes them worth testing separately from the arithmetic is that each one has
 * a *different* correct behaviour for the same underlying "this is not
 * allowed": an unconfigured vision role is a 422 that names two environment
 * variables, an over-long document is a 413, and an unknown page count is
 * deliberately let through for the worker to catch.
 *
 * The database is stubbed rather than started. The month's spend is one
 * aggregate query and the interesting logic is entirely on this side of it;
 * `documents.integration.test.ts` is where a real Postgres is involved.
 */

const spend = vi.hoisted(() => ({ value: 0 }));

vi.mock('@konusbitr/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@konusbitr/db')>();
  return {
    ...actual,
    scopedDb: () => ({
      vlmSpendThisMonth: async () => spend.value,
      recordCredit: async () => undefined,
    }),
  };
});

vi.mock('@/lib/db', () => ({ db: () => ({}) }));

const { assertAllowed, checkAllowance, estimateFor, visionRole } = await import('@/lib/ingest/vlm');
const { IngestError } = await import('@/lib/ingest/errors');

const BASE = {
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://konusbitr:konusbitr@localhost:5432/konusbitr',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'konusbitr',
  S3_ACCESS_KEY_ID: 'konusbitr',
  S3_SECRET_ACCESS_KEY: 'konusbitr-dev-secret',
  AUTH_SECRET: 'konusbitr-development-secret-change-me',
};

function env(overrides: Record<string, string> = {}) {
  return parseEnv({ ...BASE, ...overrides });
}

/** An env with a vision role that resolves, which the default `.env` has not. */
function configured(overrides: Record<string, string> = {}) {
  return env({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'sk-test', ...overrides });
}

const ADVANCED = { quality: 'advanced' as const, langList: [], llm: false };
const STANDARD = { quality: 'standard' as const, langList: [], llm: false };

beforeEach(() => {
  spend.value = 0;
});

describe('visionRole', () => {
  it('resolves the model the router would actually call', () => {
    // The price quoted has to be the price of the model that runs. Quoting
    // gpt-4.1-mini and running claude-sonnet-4-5 is a bill nobody approved.
    expect(visionRole(configured()).model).toBe('gpt-4.1-mini');
  });

  it('honours an explicit model over the provider default', () => {
    expect(visionRole(configured({ VISION_MODEL: 'gpt-4o' })).model).toBe('gpt-4o');
  });

  it('follows VISION_PROVIDER rather than LLM_PROVIDER when both are set', () => {
    const role = visionRole(configured({ VISION_PROVIDER: 'anthropic' }));
    expect(role.provider).toBe('anthropic');
    expect(role.model).toBe('claude-sonnet-4-5');
  });

  it('reports the default .env as unconfigured', () => {
    // No API key and no local provider: the state `docker compose up` starts in.
    expect(visionRole(env()).configured).toBe(false);
  });

  it('treats a local provider as configured without a key', () => {
    expect(visionRole(env({ LLM_PROVIDER: 'ollama' })).configured).toBe(true);
  });

  it('resolves a local deployment to Qwen2.5-VL', () => {
    // Not Llama 3.2 Vision: reading a page into structured elements needs
    // coordinates back, and an element with no box cannot be cited.
    expect(visionRole(env({ LLM_PROVIDER: 'ollama' })).model).toContain('qwen');
  });
});

describe('checkAllowance', () => {
  it('allows an ordinary document', async () => {
    const allowance = await checkAllowance('org_test', configured(), 12);
    expect(allowance.allowed).toBe(true);
    expect(allowance.reason).toBeNull();
  });

  it('refuses when no vision role is configured, naming what to set', async () => {
    const allowance = await checkAllowance('org_test', env(), 12);
    expect(allowance.allowed).toBe(false);
    expect(allowance.reason).toBe('not_configured');
    expect(allowance.message).toContain('VISION_PROVIDER');
  });

  it('refuses when the operator switched the tier off, and says so', async () => {
    const allowance = await checkAllowance('org_test', configured({ VLM_ENABLED: 'false' }), 12);
    expect(allowance.reason).toBe('not_configured');
    expect(allowance.message).toContain('switched off');
  });

  it('refuses a document past the page ceiling', async () => {
    const allowance = await checkAllowance('org_test', configured(), 400);
    expect(allowance.allowed).toBe(false);
    expect(allowance.reason).toBe('too_many_pages');
    expect(allowance.message).toContain('400');
  });

  it('allows a document exactly at the ceiling', async () => {
    expect((await checkAllowance('org_test', configured(), 50)).allowed).toBe(true);
  });

  it('honours a lowered ceiling', async () => {
    const tight = configured({ MAX_VLM_PAGES_PER_JOB: '10' });
    expect((await checkAllowance('org_test', tight, 11)).reason).toBe('too_many_pages');
  });

  it('reports no spend figure when no cap is set', async () => {
    // The self-host default. A cap of zero means unlimited, and showing an
    // allowance of $0.00 remaining would read as the opposite.
    expect((await checkAllowance('org_test', configured(), 10)).spend).toBeNull();
  });

  it('reports the remaining allowance when a cap is set', async () => {
    spend.value = 4;
    const allowance = await checkAllowance(
      'org_test',
      configured({ ORG_MONTHLY_VLM_USD_CAP: '10' }),
      5,
    );
    expect(allowance.spend).toEqual({
      monthToDateUsd: 4,
      capUsd: 10,
      remainingUsd: 6,
    });
  });

  it('refuses a document that would cross the monthly cap', async () => {
    spend.value = 9.99;
    const capped = configured({ ORG_MONTHLY_VLM_USD_CAP: '10', VLM_USD_PER_PAGE: '1' });
    const allowance = await checkAllowance('org_test', capped, 5);

    expect(allowance.allowed).toBe(false);
    expect(allowance.reason).toBe('spend_cap_reached');
  });

  it('does not apply a cap to a local model, which costs nothing', async () => {
    // A self-hosted model on the operator's own GPU is electricity, not an
    // invoice, and metering it against a dollar cap would be a lie in the
    // direction that stops people using the offline path.
    spend.value = 1000;
    const local = env({ LLM_PROVIDER: 'ollama', ORG_MONTHLY_VLM_USD_CAP: '10' });
    expect((await checkAllowance('org_test', local, 20)).allowed).toBe(true);
  });
});

describe('assertAllowed', () => {
  it('is a no-op for a standard parse', async () => {
    // Even at four thousand pages: the ceiling is about what a vision model
    // costs, and a standard parse does not call one.
    await expect(assertAllowed('org_test', env(), STANDARD, 4000)).resolves.toBeUndefined();
  });

  it('allows an ordinary advanced parse', async () => {
    await expect(assertAllowed('org_test', configured(), ADVANCED, 12)).resolves.toBeUndefined();
  });

  it('raises a 413 for too many pages', async () => {
    await expect(assertAllowed('org_test', configured(), ADVANCED, 400)).rejects.toMatchObject({
      status: 413,
      code: 'too_many_pages',
    });
  });

  it('raises a 422 when the tier is unavailable', async () => {
    // Not a 413: nothing about the request is too large, the instance simply
    // cannot serve it, and a client retrying with a shorter document would
    // still fail.
    await expect(assertAllowed('org_test', env(), ADVANCED, 12)).rejects.toMatchObject({
      status: 422,
      code: 'not_configured',
    });
  });

  it('raises an IngestError, so the route renders it as a problem response', async () => {
    await expect(assertAllowed('org_test', env(), ADVANCED, 12)).rejects.toBeInstanceOf(
      IngestError,
    );
  });

  it('lets an unknown page count through for the worker to catch', async () => {
    // `pageCount` is null for a PDF that hides its page objects inside an
    // object stream, which the streaming intake scanner cannot see into.
    // Guessing high would refuse ordinary documents and guessing low would
    // defeat the guardrail, so the decision defers to the side that opens the
    // file properly.
    await expect(assertAllowed('org_test', configured(), ADVANCED, null)).resolves.toBeUndefined();
  });

  it('still refuses an unconfigured tier when the page count is unknown', async () => {
    // Unlike the ceiling, this answer does not depend on the document at all.
    await expect(assertAllowed('org_test', env(), ADVANCED, null)).rejects.toMatchObject({
      code: 'not_configured',
    });
  });
});

describe('estimateFor', () => {
  it('passes the configured render DPI through to the arithmetic', () => {
    const coarse = estimateFor(configured({ VLM_DPI: '96' }), 10);
    const fine = estimateFor(configured({ VLM_DPI: '150' }), 10);
    expect(coarse.promptTokens).toBeLessThan(fine.promptTokens);
  });

  it('passes an operator per-page price through', () => {
    const estimate = estimateFor(configured({ VLM_USD_PER_PAGE: '0.05' }), 10);
    expect(estimate.pricedFrom).toBe('operator');
    expect(estimate.estimatedUsd).toBeCloseTo(0.5, 6);
  });
});
