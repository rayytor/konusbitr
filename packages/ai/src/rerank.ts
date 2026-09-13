import type { Env } from '@konusbitr/shared';
import {
  type CircuitBreaker,
  isRetryableStatus,
  ModelCallError,
  withResilience,
} from './resilience.js';
import { type ResolvedModel, resolveModel } from './roles.js';
import { estimateCostUsd, logUsage, type UsageSink } from './usage.js';

export type RerankOptions = {
  env: Env;
  breaker?: CircuitBreaker;
  usage?: UsageSink;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  topN?: number;
};

export type RerankResult = {
  index: number;
  score: number;
};

/**
 * Rerank documents against a query using a cross-encoder model.
 *
 * Supports Cohere Rerank API and standard local reranker endpoints
 * (such as TEI, vLLM, or LiteLLM proxy).
 */
export async function rerankTexts(
  query: string,
  documents: readonly string[],
  options: RerankOptions,
): Promise<RerankResult[]> {
  if (documents.length === 0) return [];

  const model = resolveModel(options.env, 'rerank');
  const started = Date.now();
  let attempts = 0;

  const results = await withResilience(
    {
      role: 'rerank',
      attempts: options.env.MODEL_MAX_RETRIES,
      breaker: options.breaker,
    },
    async (attempt) => {
      attempts = attempt;
      return requestRerank(query, documents, model, options);
    },
  );

  (options.usage ?? logUsage)({
    role: 'rerank',
    provider: model.provider,
    model: model.model,
    items: documents.length,
    promptTokens: 0,
    completionTokens: 0,
    durationMs: Date.now() - started,
    attempts,
    costUsd: estimateCostUsd(model.model, 0, 0),
  });

  return results;
}

async function requestRerank(
  query: string,
  documents: readonly string[],
  model: ResolvedModel,
  options: RerankOptions,
): Promise<RerankResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(model.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);

  const topN = options.topN ?? documents.length;
  // `documents` is what Cohere's `/v1/rerank` and the TEI and Infinity servers
  // that copy its shape all read. Some builds of TEI accept `texts` instead, so
  // both are sent — a server that reads one and ignores the other is the common
  // case, and a server that rejects unknown fields is not, but it is a real
  // enough shape that the duplication is deliberate rather than accidental.
  const body: Record<string, unknown> = {
    model: model.model,
    query,
    documents: [...documents],
    texts: [...documents],
    top_n: topN,
  };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (model.apiKey !== undefined) {
    headers.authorization = `Bearer ${model.apiKey}`;
  }

  // Endpoints typically serve at `/rerank` (relative to origin or `/v1`)
  const url = model.baseUrl.endsWith('/v1')
    ? `${model.baseUrl}/rerank`
    : `${model.baseUrl}/v1/rerank`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelCallError(`failed to reach ${model.provider} rerank: ${message}`, {
      role: 'rerank',
      cause: error,
      retryable: true,
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ModelCallError(
      `${model.provider} rerank responded ${response.status}: ${text.slice(0, 200)}`,
      {
        role: 'rerank',
        status: response.status,
        retryable: isRetryableStatus(response.status),
      },
    );
  }

  type RawRerankItem = {
    index?: number;
    score?: number;
    relevance_score?: number;
  };

  type RawRerankResponse =
    | RawRerankItem[]
    | {
        results?: RawRerankItem[];
      };

  const data = (await response.json()) as RawRerankResponse;
  const parsed = parseRerankResponse(data);
  return parsed.sort((a, b) => b.score - a.score);
}

function parseRerankResponse(
  data:
    | Array<{ index?: number; score?: number; relevance_score?: number }>
    | { results?: Array<{ index?: number; score?: number; relevance_score?: number }> },
): RerankResult[] {
  if (Array.isArray(data)) {
    return data.map((item) => ({
      index: Number(item.index),
      score: Number(item.score ?? item.relevance_score ?? 0),
    }));
  }
  if (data && Array.isArray(data.results)) {
    return data.results.map((item) => ({
      index: Number(item.index),
      score: Number(item.relevance_score ?? item.score ?? 0),
    }));
  }
  return [];
}
