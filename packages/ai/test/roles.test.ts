import { type Env, parseEnv } from '@konusbitr/shared';
import { describe, expect, it } from 'vitest';
import { OfflineModeError } from '../src/offline.js';
import {
  canResolveModel,
  ModelNotConfiguredError,
  resolveModel,
  stripProviderPrefix,
} from '../src/roles.js';

const base = {
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://konusbitr:konusbitr@localhost:5432/konusbitr',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'konusbitr',
  S3_ACCESS_KEY_ID: 'konusbitr',
  S3_SECRET_ACCESS_KEY: 'konusbitr-dev-secret',
};

function env(overrides: Record<string, string>): Env {
  return parseEnv({ ...base, ...overrides });
}

describe('stripProviderPrefix', () => {
  it('removes a LiteLLM provider prefix', () => {
    expect(stripProviderPrefix('ollama/bge-m3')).toBe('bge-m3');
    expect(stripProviderPrefix('openai/text-embedding-3-large')).toBe('text-embedding-3-large');
  });

  it('keeps a slash that belongs to the model name', () => {
    // vLLM serves HuggingFace repo ids, which contain a slash of their own.
    expect(stripProviderPrefix('hosted_vllm/BAAI/bge-m3')).toBe('BAAI/bge-m3');
    expect(stripProviderPrefix('BAAI/bge-m3')).toBe('BAAI/bge-m3');
  });
});

describe('resolveModel', () => {
  it('takes the provider default when only a provider is named', () => {
    const model = resolveModel(
      env({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'sk-test' }),
      'embedding',
    );

    expect(model.model).toBe('text-embedding-3-large');
    expect(model.baseUrl).toBe('https://api.openai.com/v1');
    expect(model.dimensions).toBe(1024);
  });

  it('routes a role to its own provider', () => {
    // The mixed deployment this whole design exists for: cloud chat, local
    // embeddings, so document text never leaves the building.
    const configured = env({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'sk-test',
      EMBEDDING_PROVIDER: 'ollama',
      EMBEDDING_MODEL: 'ollama/bge-m3',
      OLLAMA_BASE_URL: 'http://ollama:11434',
    });

    expect(resolveModel(configured, 'chat').provider).toBe('openai');

    const embedding = resolveModel(configured, 'embedding');
    expect(embedding.provider).toBe('ollama');
    expect(embedding.baseUrl).toBe('http://ollama:11434/v1');
    expect(embedding.model).toBe('bge-m3');
  });

  it('sends everything through LLM_BASE_URL when one is set', () => {
    const model = resolveModel(
      env({
        LLM_PROVIDER: 'openai',
        LLM_API_KEY: 'sk-test',
        LLM_BASE_URL: 'https://gateway.internal.example/v1',
      }),
      'embedding',
    );

    expect(model.baseUrl).toBe('https://gateway.internal.example/v1');
  });

  it('appends /v1 exactly once', () => {
    expect(
      resolveModel(
        env({
          LLM_PROVIDER: 'ollama',
          EMBEDDING_MODEL: 'bge-m3',
          OLLAMA_BASE_URL: 'http://ollama:11434/',
        }),
        'embedding',
      ).baseUrl,
    ).toBe('http://ollama:11434/v1');
  });

  it('gives embeddings their own, longer deadline', () => {
    // One batch of 64 passages is not one chat turn, and a single timeout for
    // both would either cut embedding off or let a hung chat hold a request.
    const configured = env({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'sk-test',
      MODEL_TIMEOUT_SECONDS: '30',
      EMBEDDING_TIMEOUT_SECONDS: '180',
    });

    expect(resolveModel(configured, 'chat').timeoutMs).toBe(30_000);
    expect(resolveModel(configured, 'embedding').timeoutMs).toBe(180_000);
  });

  it('refuses a role nothing has configured', () => {
    // The default `.env.example`: LLM_PROVIDER=openai with no key. That must
    // not resolve to a call that 401s — it is an unconfigured stack, and the
    // caller is meant to chunk without embedding and say so.
    expect(() => resolveModel(env({}), 'embedding')).toThrow(ModelNotConfiguredError);
    expect(canResolveModel(env({}), 'embedding')).toBe(false);
  });

  it('treats a local provider as configured without a key', () => {
    expect(canResolveModel(env({ LLM_PROVIDER: 'ollama' }), 'embedding')).toBe(true);
  });

  it('has no default rerank model to guess at', () => {
    // Reranker choices differ enough that a guess would silently change
    // retrieval quality; Phase 09 configures one or falls back to fusion.
    expect(() => resolveModel(env({ LLM_PROVIDER: 'ollama' }), 'rerank')).toThrow(
      ModelNotConfiguredError,
    );
  });

  it('needs a base URL before it will route to vLLM', () => {
    expect(() =>
      resolveModel(env({ LLM_PROVIDER: 'vllm', EMBEDDING_MODEL: 'BAAI/bge-m3' }), 'embedding'),
    ).toThrow(/VLLM_BASE_URL/);
  });

  it('refuses a cloud endpoint under offline mode, before a body is built', () => {
    // Boot validation already stops this configuration from starting a
    // process; this is the second gate, for configuration that changed under a
    // running one.
    const offline = {
      ...parseEnv({ ...base, LLM_PROVIDER: 'ollama', EMBEDDING_MODEL: 'bge-m3' }),
      OFFLINE_MODE: true,
      EMBEDDING_PROVIDER: 'openai' as const,
      LLM_API_KEY: 'sk-test',
    };

    expect(() => resolveModel(offline, 'embedding')).toThrow(OfflineModeError);
  });

  it('refuses a local provider pointed at a public host under offline mode', () => {
    // A cloud call wearing a local provider's name. Checking the provider
    // alone would let this through.
    const offline = {
      ...parseEnv({ ...base, LLM_PROVIDER: 'ollama', EMBEDDING_MODEL: 'bge-m3' }),
      OFFLINE_MODE: true,
      OLLAMA_BASE_URL: 'https://ollama.somebody-elses-cloud.example',
    };

    expect(() => resolveModel(offline, 'embedding')).toThrow(OfflineModeError);
  });
});
