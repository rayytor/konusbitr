import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env.js';
import {
  CLOUD_LLM_PROVIDERS,
  EMBEDDING_DIMENSIONS,
  isLocalProvider,
  LLM_PROVIDERS,
  LOCAL_LLM_PROVIDERS,
  providerCanEmbed,
} from '../src/models.js';

const valid = {
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://konusbitr:konusbitr@localhost:5432/konusbitr',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'konusbitr',
  S3_ACCESS_KEY_ID: 'konusbitr',
  S3_SECRET_ACCESS_KEY: 'konusbitr-dev-secret',
};

describe('the provider vocabulary', () => {
  it('partitions every provider into local or cloud', () => {
    // A provider in neither list would slip through the offline check, which is
    // the one place this partition has to be total.
    const partitioned = [...LOCAL_LLM_PROVIDERS, ...CLOUD_LLM_PROVIDERS].toSorted();
    expect(partitioned).toEqual([...LLM_PROVIDERS].toSorted());
  });

  it('calls only operator-controlled endpoints local', () => {
    expect(isLocalProvider('ollama')).toBe(true);
    expect(isLocalProvider('vllm')).toBe(true);
    expect(isLocalProvider('openai')).toBe(false);
  });

  it('knows which providers have no embedding endpoint', () => {
    expect(providerCanEmbed('anthropic')).toBe(false);
    expect(providerCanEmbed('google')).toBe(false);
    expect(providerCanEmbed('ollama')).toBe(true);
  });
});

describe('OFFLINE_MODE at boot', () => {
  it('refuses to start when a cloud provider is the fallback', () => {
    expect(() => parseEnv({ ...valid, OFFLINE_MODE: 'true' })).toThrow(
      /OFFLINE_MODE: is true, but a cloud provider is configured \(LLM_PROVIDER=openai\)/,
    );
  });

  it('refuses to start when one role alone reaches the cloud', () => {
    // The case a check on LLM_PROVIDER alone would miss: everything local
    // except the chat model, which is still a document leaving the building.
    expect(() =>
      parseEnv({
        ...valid,
        OFFLINE_MODE: 'true',
        LLM_PROVIDER: 'ollama',
        CHAT_PROVIDER: 'openai',
      }),
    ).toThrow(/CHAT_PROVIDER=openai/);
  });

  it('refuses an OpenAI-compatible proxy hosted on the internet', () => {
    expect(() =>
      parseEnv({
        ...valid,
        OFFLINE_MODE: 'true',
        LLM_PROVIDER: 'ollama',
        LLM_BASE_URL: 'https://proxy.example.com/v1',
      }),
    ).toThrow(/LLM_BASE_URL: points at proxy\.example\.com/);
  });

  it('starts with only Ollama configured', () => {
    const env = parseEnv({
      ...valid,
      OFFLINE_MODE: 'true',
      LLM_PROVIDER: 'ollama',
      EMBEDDING_MODEL: 'ollama/bge-m3',
      OLLAMA_BASE_URL: 'http://ollama:11434',
    });

    expect(env.OFFLINE_MODE).toBe(true);
    expect(env.EMBEDDING_DIMENSIONS).toBe(EMBEDDING_DIMENSIONS);
  });

  it('allows a proxy on a private address', () => {
    expect(() =>
      parseEnv({
        ...valid,
        OFFLINE_MODE: 'true',
        LLM_PROVIDER: 'vllm',
        VLLM_BASE_URL: 'http://10.0.0.4:8000',
        LLM_BASE_URL: 'http://10.0.0.4:8000/v1',
        EMBEDDING_MODEL: 'hosted_vllm/BAAI/bge-m3',
      }),
    ).not.toThrow();
  });
});

describe('role configuration', () => {
  it('rejects an embedding provider that has no embedding endpoint', () => {
    expect(() =>
      parseEnv({
        ...valid,
        LLM_API_KEY: 'sk-test',
        EMBEDDING_PROVIDER: 'anthropic',
      }),
    ).toThrow(/EMBEDDING_PROVIDER: is anthropic, which has no embedding endpoint/);
  });

  it('leaves an unconfigured stack alone', () => {
    // The default `.env.example`: nothing is configured, and that has to boot.
    // Chunking still runs; the passages simply have no vectors until an
    // operator names a model and reindexes.
    const env = parseEnv(valid);
    expect(env.LLM_API_KEY).toBeUndefined();
    expect(env.EMBEDDING_MODEL).toBeUndefined();
  });

  it('rejects a chunk band that cannot be satisfied', () => {
    expect(() =>
      parseEnv({ ...valid, CHUNK_MIN_TOKENS: '900', CHUNK_TARGET_TOKENS: '800' }),
    ).toThrow(/CHUNK_MIN_TOKENS: is 900, above CHUNK_TARGET_TOKENS=800/);
  });
});
