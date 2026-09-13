import { parseEnv } from '@konusbitr/shared';
import { describe, expect, it } from 'vitest';
import { rerankTexts } from '../src/rerank.js';

const baseEnv = {
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://konusbitr:konusbitr@localhost:5432/konusbitr',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'konusbitr',
  S3_ACCESS_KEY_ID: 'konusbitr',
  S3_SECRET_ACCESS_KEY: 'konusbitr-dev-secret',
};

describe('rerankTexts', () => {
  it('returns empty array when documents are empty', async () => {
    const env = parseEnv({
      ...baseEnv,
      RERANK_PROVIDER: 'ollama',
      RERANK_MODEL: 'BAAI/bge-reranker-v2-m3',
      OLLAMA_BASE_URL: 'http://localhost:11434',
    });
    const results = await rerankTexts('test query', [], { env });
    expect(results).toEqual([]);
  });

  it('reranks documents through Cohere API response format', async () => {
    const env = parseEnv({
      ...baseEnv,
      RERANK_PROVIDER: 'cohere',
      RERANK_MODEL: 'rerank-v3.5',
      LLM_API_KEY: 'cohere-test-key',
    });

    const fakeFetch: typeof fetch = async (input, init) => {
      expect(String(input)).toContain('https://api.cohere.com/v1/rerank');
      const body = JSON.parse(String(init?.body));
      expect(body.query).toBe('capital of France');
      expect(body.documents).toEqual(['Berlin is in Germany', 'Paris is the capital of France']);

      return new Response(
        JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.98 },
            { index: 0, relevance_score: 0.05 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const results = await rerankTexts(
      'capital of France',
      ['Berlin is in Germany', 'Paris is the capital of France'],
      { env, fetchImpl: fakeFetch },
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ index: 1, score: 0.98 });
    expect(results[1]).toEqual({ index: 0, score: 0.05 });
  });

  it('handles array-style response from TEI or local reranker', async () => {
    const env = parseEnv({
      ...baseEnv,
      RERANK_PROVIDER: 'vllm',
      RERANK_MODEL: 'BAAI/bge-reranker-v2-m3',
      VLLM_BASE_URL: 'http://localhost:8000',
    });

    const fakeFetch: typeof fetch = async (input, _init) => {
      expect(String(input)).toContain('http://localhost:8000/v1/rerank');
      return new Response(
        JSON.stringify([
          { index: 0, score: 0.12 },
          { index: 1, score: 0.89 },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const results = await rerankTexts('query', ['doc 0', 'doc 1'], {
      env,
      fetchImpl: fakeFetch,
    });

    // Should be sorted by score descending
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ index: 1, score: 0.89 });
    expect(results[1]).toEqual({ index: 0, score: 0.12 });
  });
});
