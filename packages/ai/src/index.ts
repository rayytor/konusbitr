/**
 * `@konusbitr/ai` — the TypeScript half of the model router.
 *
 * Konusbitr never imports a provider SDK. Every model call the product surface
 * makes goes through this package; the document pipeline's calls go through
 * `konusbitr_worker.ai`, which wraps LiteLLM. The two share their vocabulary —
 * roles, the local/cloud partition, the environment contract — through
 * `@konusbitr/shared`, so an operator configures one `.env` and both halves
 * agree about what it said.
 *
 * Prompts live in `prompts/` as versioned files, never as inline string
 * literals, so that a change in an eval score can be attributed to a change in
 * a prompt.
 */

export {
  type ChatMessage,
  type ChatOptions,
  completeChat,
} from './chat.js';
export {
  type CitationVerificationResult,
  fuzzyIncludes,
  type GroundedChunk,
  levenshteinDistance,
  normalizeText,
  parseInlineCitationMarkers,
  parseStructuredCitations,
  type RawCitation,
  removeCitationsBlock,
  stringSimilarity,
  verifyCitations,
} from './citations.js';

export {
  buildContext,
  estimateTokens,
  windowHistory,
} from './context.js';
export {
  breakerFor,
  EmbeddingDimensionError,
  type EmbedOptions,
  embedQuery,
  embedTexts,
} from './embed.js';
export { assertReachable, isLocalEndpoint, OfflineModeError } from './offline.js';
export { loadPrompt } from './prompts.js';
export {
  type RerankOptions,
  type RerankResult,
  rerankTexts,
} from './rerank.js';
export {
  CircuitBreaker,
  CircuitOpenError,
  isRetryableStatus,
  ModelCallError,
  withResilience,
} from './resilience.js';
export {
  canResolveModel,
  ModelNotConfiguredError,
  type ResolvedModel,
  resolveModel,
  stripProviderPrefix,
} from './roles.js';
export {
  getChatLanguageModel,
  type StreamChatOptions,
  streamChat,
} from './stream.js';
export {
  collectUsage,
  estimateCostUsd,
  logUsage,
  type UsageRecord,
  type UsageSink,
} from './usage.js';
