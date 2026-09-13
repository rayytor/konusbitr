import { z } from 'zod';

/**
 * The model-router contract: which roles exist, which providers can serve
 * them, and which of those are local.
 *
 * Konusbitr never imports a provider SDK. Every model call goes through one
 * router — LiteLLM in the Python worker, the OpenAI-compatible client in
 * `@konusbitr/ai` — and this module is the vocabulary both of them share with
 * the environment contract.
 *
 * The reason roles are independent rather than one "model" setting is that
 * operators genuinely mix them: a law firm runs a cloud chat model and keeps
 * embeddings local so that document text never leaves the building, and a
 * government deployment runs everything local. Neither is expressible if
 * `LLM_PROVIDER` is the only knob.
 */

/**
 * What a model is being asked to do.
 *
 * All four are declared now because the environment contract and the offline
 * check have to cover every role a future phase can configure: a `rerank`
 * model pointed at a cloud endpoint would leak document text in Phase 09
 * exactly as a `chat` one would in Phase 10, and an `OFFLINE_MODE` that only
 * knew about the roles in use today would not have caught it.
 */
export const MODEL_ROLES = ['chat', 'embedding', 'rerank', 'vision'] as const;

export const ModelRoleSchema = z.enum(MODEL_ROLES);

export type ModelRole = z.infer<typeof ModelRoleSchema>;

/** Providers the router knows how to address. */
export const LLM_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'mistral',
  'ollama',
  'vllm',
  'cohere',
] as const;

export const LlmProviderSchema = z.enum(LLM_PROVIDERS);

export type LlmProvider = z.infer<typeof LlmProviderSchema>;

/**
 * Providers that run on hardware the operator controls.
 *
 * This list is what `OFFLINE_MODE=true` permits, and it is the whole of the
 * definition — there is no second place that decides what "local" means.
 * Adding a provider here is a claim that a document's text cannot leave the
 * deployment through it, so it is a decision, not a configuration detail.
 */
export const LOCAL_LLM_PROVIDERS = ['ollama', 'vllm'] as const satisfies readonly LlmProvider[];

/** Everything else: an endpoint on somebody else's computer. */
export const CLOUD_LLM_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'mistral',
  'cohere',
] as const satisfies readonly LlmProvider[];

export function isLocalProvider(provider: LlmProvider): boolean {
  return (LOCAL_LLM_PROVIDERS as readonly LlmProvider[]).includes(provider);
}

/**
 * The embedding width the `chunks.embedding` column is declared at.
 *
 * **This number is in the DDL.** pgvector needs a fixed dimension to build an
 * HNSW index — `CREATE INDEX … USING hnsw (embedding vector_cosine_ops)` on an
 * untyped `vector` column fails with "column does not have dimensions" — so
 * the column is `vector(1024)` and every configured embedding model has to
 * produce exactly that many numbers. 1024 is BGE-M3's native width and a width
 * `text-embedding-3-large` supports natively through Matryoshka truncation,
 * which is what makes cloud and local interchangeable behind one column.
 *
 * Changing it is a migration plus a full reindex of every document, which is
 * why the worker refuses to write a vector of the wrong width rather than
 * letting Postgres raise from inside a batch insert.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * The model each provider gets when only a provider is named.
 *
 * Spelled with LiteLLM's `provider/model` prefixes, because that is what both
 * routers pass through: `ollama/bge-m3` reaches a local Ollama, `bge-m3` alone
 * would be guessed at. `vllm` serves whatever was loaded into it, so it has no
 * default worth inventing and an operator must name the model.
 */
export const DEFAULT_EMBEDDING_MODELS: Readonly<Partial<Record<LlmProvider, string>>> =
  Object.freeze({
    openai: 'text-embedding-3-large',
    mistral: 'mistral-embed',
    ollama: 'ollama/bge-m3',
  });

/** The chat model each provider gets when only a provider is named. */
export const DEFAULT_CHAT_MODELS: Readonly<Partial<Record<LlmProvider, string>>> = Object.freeze({
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-sonnet-4-5',
  google: 'gemini-2.5-flash',
  mistral: 'mistral-small-latest',
  ollama: 'ollama/llama3.2:3b',
});

/** Default rerank model for providers that support reranking. */
export const DEFAULT_RERANK_MODELS: Readonly<Partial<Record<LlmProvider, string>>> = Object.freeze({
  cohere: 'rerank-v3.5',
  ollama: 'BAAI/bge-reranker-v2-m3',
  vllm: 'BAAI/bge-reranker-v2-m3',
});

/**
 * Providers with no embedding endpoint at all.
 *
 * Anthropic and Google Vertex both serve chat and vision and neither exposes
 * an embedding API this router can address. Cohere is used specifically for
 * reranking in Konusbitr.
 */
export const PROVIDERS_WITHOUT_EMBEDDINGS = [
  'anthropic',
  'google',
  'cohere',
] as const satisfies readonly LlmProvider[];

export function providerCanEmbed(provider: LlmProvider): boolean {
  return !(PROVIDERS_WITHOUT_EMBEDDINGS as readonly LlmProvider[]).includes(provider);
}
