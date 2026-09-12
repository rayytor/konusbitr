import { type Env, parseEnv } from '@konusbitr/shared';
import { describe, expect, it, vi } from 'vitest';
import { EmbeddingDimensionError, embedQuery, embedTexts } from '../src/embed.js';
import { ModelCallError } from '../src/resilience.js';
import { collectUsage } from '../src/usage.js';

const base = {
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://konusbitr:konusbitr@localhost:5432/konusbitr',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'konusbitr',
  S3_ACCESS_KEY_ID: 'konusbitr',
  S3_SECRET_ACCESS_KEY: 'konusbitr-dev-secret',
};

function env(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    ...base,
    LLM_PROVIDER: 'ollama',
    EMBEDDING_MODEL: 'ollama/bge-m3',
    OLLAMA_BASE_URL: 'http://ollama:11434',
    ...overrides,
  });
}

const vector = (seed: number, dims = 1024): number[] =>
  Array.from({ length: dims }, (_, i) => (seed + i) / 10_000);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('embedTexts', () => {
  it('asks one request for the whole batch', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { index: 0, embedding: vector(1) },
          { index: 1, embedding: vector(2) },
        ],
        usage: { prompt_tokens: 12 },
      }),
    );

    const vectors = await embedTexts(['one', 'two'], { env: env(), fetchImpl, usage: () => {} });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://ollama:11434/v1/embeddings');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'bge-m3', input: ['one', 'two'] });
    expect(vectors).toHaveLength(2);
  });

  it('restores the order the provider returned them in', async () => {
    // The API documents input order, but a proxy in the middle is under no
    // such obligation — and a transposed batch attaches every chunk's vector
    // to its neighbour's text, which is a bug with no symptom except worse
    // retrieval.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { index: 1, embedding: vector(200) },
          { index: 0, embedding: vector(100) },
        ],
      }),
    );

    const [first, second] = await embedTexts(['a', 'b'], {
      env: env(),
      fetchImpl,
      usage: () => {},
    });

    expect(first?.[0]).toBeCloseTo(100 / 10_000);
    expect(second?.[0]).toBeCloseTo(200 / 10_000);
  });

  it('asks OpenAI for the width the column is declared at', async () => {
    // Matryoshka truncation: `text-embedding-3-large` is natively 3072 and
    // returns 1024 on request, which is what makes cloud and local
    // interchangeable behind one `vector(1024)` column.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ index: 0, embedding: vector(1) }] }),
    );

    await embedTexts(['q'], {
      env: env({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'sk-test', EMBEDDING_MODEL: '' }),
      fetchImpl,
      usage: () => {},
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'text-embedding-3-large',
      dimensions: 1024,
    });
  });

  it('does not send `dimensions` to a server that has never heard of it', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ index: 0, embedding: vector(1) }] }),
    );

    await embedTexts(['q'], { env: env(), fetchImpl, usage: () => {} });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty('dimensions');
  });

  it('refuses a vector of the wrong width, naming the variable to change', async () => {
    // A mixed index does not fail; it silently returns cosine distances
    // between two unrelated spaces. So the width is asserted here.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ index: 0, embedding: vector(1, 768) }] }),
    );

    await expect(embedTexts(['q'], { env: env(), fetchImpl, usage: () => {} })).rejects.toThrow(
      EmbeddingDimensionError,
    );
    await expect(embedTexts(['q'], { env: env(), fetchImpl, usage: () => {} })).rejects.toThrow(
      /EMBEDDING_DIMENSIONS/,
    );
  });

  it('refuses a batch with a gap in it rather than storing an undefined', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { index: 0, embedding: vector(1) },
          { index: 0, embedding: vector(2) },
        ],
      }),
    );

    await expect(
      embedTexts(['a', 'b'], { env: env(), fetchImpl, usage: () => {} }),
    ).rejects.toThrow(ModelCallError);
  });

  it('reports usage without repeating a word of the input', async () => {
    // A usage record goes to logs an operator reads and, in Phase 15, to a
    // third-party observability platform. Document text reaches neither.
    const { sink, records } = collectUsage();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ index: 0, embedding: vector(1) }], usage: { prompt_tokens: 7 } }),
    );

    await embedTexts(['Revenue grew 18% year over year'], { env: env(), fetchImpl, usage: sink });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      role: 'embedding',
      provider: 'ollama',
      model: 'bge-m3',
      items: 1,
      promptTokens: 7,
      attempts: 1,
      // No published price for a local model: null, not zero dollars of a
      // metered spend.
      costUsd: null,
    });
    expect(JSON.stringify(records)).not.toContain('Revenue');
  });

  it('prices a cloud embedding call', async () => {
    const { sink, records } = collectUsage();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [{ index: 0, embedding: vector(1) }],
        usage: { prompt_tokens: 1_000_000 },
      }),
    );

    await embedTexts(['q'], {
      env: env({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'sk-test', EMBEDDING_MODEL: '' }),
      fetchImpl,
      usage: sink,
    });

    expect(records[0]?.costUsd).toBeCloseTo(0.13);
  });

  it('sends the credential as a bearer token, and omits it when there is none', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ index: 0, embedding: vector(1) }] }),
    );

    await embedTexts(['q'], { env: env(), fetchImpl, usage: () => {} });
    const [, local] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(local.headers).not.toHaveProperty('authorization');

    await embedTexts(['q'], {
      env: env({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'sk-test', EMBEDDING_MODEL: '' }),
      fetchImpl,
      usage: () => {},
    });
    const [, cloud] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(cloud.headers).toMatchObject({ authorization: 'Bearer sk-test' });
  });

  it('does not call the provider for an empty batch', async () => {
    const fetchImpl = vi.fn();
    await expect(embedTexts([], { env: env(), fetchImpl })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries a rate limit and gives up on a rejected credential', async () => {
    const rateLimited = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ error: 'slow down' }, 429))
      .mockResolvedValue(jsonResponse({ data: [{ index: 0, embedding: vector(1) }] }));

    await expect(
      embedTexts(['q'], { env: env(), fetchImpl: rateLimited, usage: () => {} }),
    ).resolves.toHaveLength(1);
    expect(rateLimited).toHaveBeenCalledTimes(2);

    const unauthorized = vi.fn(async () => jsonResponse({ error: 'no' }, 401));
    await expect(
      embedTexts(['q'], { env: env(), fetchImpl: unauthorized, usage: () => {} }),
    ).rejects.toThrow(/401/);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('treats an unreachable provider as retryable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(embedTexts(['q'], { env: env(), fetchImpl, usage: () => {} })).rejects.toThrow(
      /could not be reached/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not put a provider error body into the message', async () => {
    // A provider that echoes the input back inside its error would otherwise
    // put document text into a log line.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'bad input: Revenue grew 18%' } }, 400),
    );

    await expect(
      embedTexts(['Revenue grew 18%'], { env: env(), fetchImpl, usage: () => {} }),
    ).rejects.toThrow(/answered 400/);
    await embedTexts(['x'], { env: env(), fetchImpl, usage: () => {} }).catch((error: Error) => {
      expect(error.message).not.toContain('Revenue');
    });
  });
});

describe('embedQuery', () => {
  it('returns the single vector', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ index: 0, embedding: vector(5) }] }),
    );
    const result = await embedQuery('how much revenue', { env: env(), fetchImpl, usage: () => {} });
    expect(result).toHaveLength(1024);
  });
});
