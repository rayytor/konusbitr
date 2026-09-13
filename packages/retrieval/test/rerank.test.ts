import { parseEnv } from '@konusbitr/shared';
import { describe, expect, it } from 'vitest';
import { applyReranking } from '../src/rerank.js';
import type { RetrievedChunk } from '../src/types.js';

const baseEnv = {
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://konusbitr:konusbitr@localhost:5432/konusbitr',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'konusbitr',
  S3_ACCESS_KEY_ID: 'konusbitr',
  S3_SECRET_ACCESS_KEY: 'konusbitr-dev-secret',
};

function makeChunk(id: string, text: string, score: number): RetrievedChunk {
  return {
    id,
    documentId: 'doc_1',
    ordinal: 0,
    text,
    score,
    sectionPath: null,
    pages: [{ page: 1, bbox: [0, 0, 100, 100] }],
    page: 1,
    bbox: [0, 0, 100, 100],
  };
}

describe('applyReranking', () => {
  it('skips reranking and preserves RRF order when rerankEnabled is false', async () => {
    const candidates = [
      makeChunk('chk_1', 'First chunk', 0.9),
      makeChunk('chk_2', 'Second chunk', 0.8),
    ];

    const result = await applyReranking({
      query: 'test query',
      candidates,
      topK: 2,
      rerankEnabled: false,
    });

    expect(result).toEqual(candidates);
  });

  it('skips reranking when no reranker is configured', async () => {
    const env = parseEnv(baseEnv);
    const candidates = [
      makeChunk('chk_1', 'First chunk', 0.9),
      makeChunk('chk_2', 'Second chunk', 0.8),
    ];

    const result = await applyReranking({
      query: 'test query',
      candidates,
      topK: 2,
      env,
    });

    expect(result).toEqual(candidates);
  });

  it('falls back to RRF order when reranker call fails', async () => {
    const env = parseEnv({
      ...baseEnv,
      RERANK_PROVIDER: 'cohere',
      RERANK_MODEL: 'rerank-v3.5',
      LLM_API_KEY: 'test-key',
    });

    const candidates = [
      makeChunk('chk_1', 'First chunk', 0.9),
      makeChunk('chk_2', 'Second chunk', 0.8),
    ];

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        return new Response('Reranker Timeout', { status: 504 });
      }) as unknown as typeof fetch;

      const result = await applyReranking({
        query: 'test query',
        candidates,
        topK: 2,
        env,
      });

      // Must not throw, returns candidates in initial order
      expect(result).toEqual(candidates);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reorders candidates according to reranker score', async () => {
    const env = parseEnv({
      ...baseEnv,
      RERANK_PROVIDER: 'cohere',
      RERANK_MODEL: 'rerank-v3.5',
      LLM_API_KEY: 'test-key',
    });

    const candidates = [
      makeChunk('chk_1', 'Document about cars', 0.9),
      makeChunk('chk_2', 'Document about boats', 0.8),
    ];

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        return new Response(
          JSON.stringify({
            results: [
              { index: 1, relevance_score: 0.99 },
              { index: 0, relevance_score: 0.12 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch;

      const result = await applyReranking({
        query: 'sailing on the water',
        candidates,
        topK: 2,
        env,
      });

      expect(result[0]?.id).toBe('chk_2');
      expect(result[0]?.score).toBe(0.99);
      expect(result[1]?.id).toBe('chk_1');
      expect(result[1]?.score).toBe(0.12);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
