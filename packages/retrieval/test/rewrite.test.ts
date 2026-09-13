import { parseEnv } from '@konusbitr/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearRewriteCache, rewriteQuery } from '../src/rewrite.js';

const baseEnv = {
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://konusbitr:konusbitr@localhost:5432/konusbitr',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'konusbitr',
  S3_ACCESS_KEY_ID: 'konusbitr',
  S3_SECRET_ACCESS_KEY: 'konusbitr-dev-secret',
};

describe('rewriteQuery', () => {
  beforeEach(() => {
    clearRewriteCache();
  });

  it('skips rewriting when there is no history', async () => {
    const query = 'What was the 2024 subscription revenue?';
    const rewritten = await rewriteQuery({
      orgId: 'org_1',
      scope: { kind: 'corpus' },
      query,
      history: [],
    });
    expect(rewritten).toBe(query);
  });

  it('caches rewritten query by conversationId and turn', async () => {
    const env = parseEnv({
      ...baseEnv,
      LLM_PROVIDER: 'openai',
      LLM_CHAT_MODEL: 'gpt-4.1-mini',
      LLM_API_KEY: 'test-key',
    });

    let calls = 0;
    // We test caching by monkeypatching or calling twice
    const options = {
      orgId: 'org_1',
      scope: { kind: 'corpus' as const },
      query: 'What about its change?',
      history: [
        { role: 'user' as const, content: 'Tell me about subscription revenue in 2024.' },
        { role: 'assistant' as const, content: 'Subscription revenue was $5,860.' },
      ],
      conversationId: 'cnv_123',
      turn: 2,
      env,
    };

    // Global fetch mock
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        calls++;
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: 'What was the change in subscription revenue in 2024?' } },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch;

      const first = await rewriteQuery(options);
      expect(first).toBe('What was the change in subscription revenue in 2024?');
      expect(calls).toBe(1);

      // Second call with same conversationId and turn should hit cache!
      const second = await rewriteQuery(options);
      expect(second).toBe(first);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to raw query when model call fails', async () => {
    const env = parseEnv({
      ...baseEnv,
      LLM_PROVIDER: 'openai',
      LLM_CHAT_MODEL: 'gpt-4.1-mini',
      LLM_API_KEY: 'test-key',
    });

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        return new Response('Internal Server Error', { status: 500 });
      }) as unknown as typeof fetch;

      const query = 'How many employees?';
      const result = await rewriteQuery({
        orgId: 'org_1',
        scope: { kind: 'corpus' },
        query,
        history: [{ role: 'user', content: 'Tell me about headcount in Europe.' }],
        env,
      });

      // Must fall back cleanly to raw query
      expect(result).toBe(query);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
