import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_EMBEDDING_MODELS,
  type Env,
  isRoleConfigured,
  type LlmProvider,
  type ModelRole,
  roleModel,
  roleProvider,
} from '@konusbitr/shared';
import { assertReachable } from './offline.js';

/**
 * Resolving a role to something callable.
 *
 * A role is a *question* — "what should embed this?" — and this module answers
 * it with a concrete endpoint, model name, credential and deadline. Everything
 * downstream of here talks HTTP and knows nothing about providers, which is
 * what makes "switch `EMBEDDING_MODEL` from a cloud model to a local one with
 * only env changes plus a reindex" true rather than aspirational.
 *
 * The route is the OpenAI-compatible API in every case. That is not a
 * simplification: it is what OpenAI, Mistral, vLLM and Ollama all serve
 * natively, and what LiteLLM's proxy serves for the rest — so one client
 * covers the providers this package has a role for, and the Python worker's
 * LiteLLM covers the ones it needs for chat.
 */

/** An endpoint resolved from configuration, ready to be called. */
export type ResolvedModel = {
  role: ModelRole;
  provider: LlmProvider;
  /** The model name as the endpoint expects it, provider prefix stripped. */
  model: string;
  /** Origin plus `/v1`, with no trailing slash. */
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs: number;
  /** Only meaningful for `embedding`; the width the vectors must come back at. */
  dimensions: number;
};

/** Raised when a role has no usable configuration. */
export class ModelNotConfiguredError extends Error {
  override readonly name = 'ModelNotConfiguredError';

  constructor(readonly role: ModelRole) {
    super(
      `No ${role} model is configured. Set ${role === 'chat' ? 'LLM_CHAT_MODEL' : `${role.toUpperCase()}_MODEL`} ` +
        'and a provider, or LLM_PROVIDER with a local provider that needs no key.',
    );
  }
}

/**
 * Where a provider's OpenAI-compatible API lives.
 *
 * `LLM_BASE_URL` overrides every one of them, which is how a self-hoster puts a
 * LiteLLM proxy, a gateway or an air-gapped mirror in front of the lot with one
 * variable.
 */
function baseUrlFor(env: Env, provider: LlmProvider): string {
  if (env.LLM_BASE_URL !== undefined) return withV1(env.LLM_BASE_URL);

  switch (provider) {
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'mistral':
      return 'https://api.mistral.ai/v1';
    case 'ollama':
      return withV1(env.OLLAMA_BASE_URL);
    case 'vllm':
      if (env.VLLM_BASE_URL === undefined) {
        throw new Error('VLLM_BASE_URL must be set when a role uses the vllm provider');
      }
      return withV1(env.VLLM_BASE_URL);
    case 'anthropic':
      return 'https://api.anthropic.com/v1';
    case 'google':
      return 'https://generativelanguage.googleapis.com/v1beta/openai';
    case 'cohere':
      return 'https://api.cohere.com/v1';
  }
}

function withV1(origin: string): string {
  const trimmed = origin.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/**
 * Strip a LiteLLM provider prefix from a model name.
 *
 * `EMBEDDING_MODEL` is written in LiteLLM's `provider/model` spelling so that
 * one variable means the same thing to both runtimes — `ollama/bge-m3` is
 * unambiguous where a bare `bge-m3` is a guess. The HTTP route wants the
 * provider's own name for the model, so the prefix comes off here rather than
 * being a second variable an operator has to keep in step.
 *
 * A model whose own name contains a slash (`BAAI/bge-m3` on vLLM) keeps it: only
 * a leading segment that names a provider Konusbitr knows is removed.
 */
const PROVIDER_PREFIXES = new Set([
  'openai',
  'anthropic',
  'gemini',
  'google',
  'mistral',
  'ollama',
  'ollama_chat',
  'hosted_vllm',
  'vllm',
  'cohere',
]);

export function stripProviderPrefix(model: string): string {
  const slash = model.indexOf('/');
  if (slash === -1) return model;
  return PROVIDER_PREFIXES.has(model.slice(0, slash)) ? model.slice(slash + 1) : model;
}

function defaultModelFor(role: ModelRole, provider: LlmProvider): string | undefined {
  if (role === 'embedding') return DEFAULT_EMBEDDING_MODELS[provider];
  if (role === 'chat' || role === 'vision') return DEFAULT_CHAT_MODELS[provider];
  // Reranking has no defensible default: the models differ enough that
  // guessing one would silently change retrieval quality. Phase 09 configures
  // it explicitly or falls back to fusion alone.
  return undefined;
}

/**
 * Resolve a role, or raise.
 *
 * Offline mode is checked here rather than at the fetch, so that a misconfigured
 * deployment fails before a request body containing document text has been
 * assembled at all.
 */
export function resolveModel(env: Env, role: ModelRole): ResolvedModel {
  const provider = roleProvider(env, role);
  const configured = roleModel(env, role);
  const model = configured ?? defaultModelFor(role, provider);

  if (model === undefined || !isRoleConfigured(env, role)) {
    throw new ModelNotConfiguredError(role);
  }

  const baseUrl = baseUrlFor(env, provider);
  assertReachable(env, provider, baseUrl);

  return {
    role,
    provider,
    model: stripProviderPrefix(model),
    baseUrl,
    apiKey: env.LLM_API_KEY,
    timeoutMs:
      (role === 'embedding' ? env.EMBEDDING_TIMEOUT_SECONDS : env.MODEL_TIMEOUT_SECONDS) * 1000,
    dimensions: env.EMBEDDING_DIMENSIONS,
  };
}

/**
 * Whether a role can be called at all, without raising to find out.
 *
 * The intake and library paths use this to render "keyword search only"
 * honestly instead of discovering an unconfigured role as an exception.
 */
export function canResolveModel(env: Env, role: ModelRole): boolean {
  try {
    resolveModel(env, role);
    return true;
  } catch {
    return false;
  }
}
