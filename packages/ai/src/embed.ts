import type { Env } from '@konusbitr/shared';
import { CircuitBreaker, isRetryableStatus, ModelCallError, withResilience } from './resilience.js';
import { type ResolvedModel, resolveModel } from './roles.js';
import { estimateCostUsd, logUsage, type UsageSink } from './usage.js';

/**
 * Embeddings, over the OpenAI-compatible route.
 *
 * The product surface needs this for one thing in Phase 09 — embedding a
 * *query* — and the worker embeds the corpus through LiteLLM. Both have to land
 * in the same vector space, which is the reason this file exists at all rather
 * than the query being embedded by asking the worker: two runtimes reading one
 * `EMBEDDING_MODEL` from one `.env` is a contract; a second service in the
 * request path is a dependency.
 *
 * The dimension check is not defensive politeness. `chunks.embedding` is
 * `vector(1024)`, and a query vector of a different width does not return worse
 * results — Postgres refuses the comparison, or worse, a model silently
 * configured at another width returns cosine distances between two unrelated
 * spaces. So the width is asserted on the way out of the router, once, where
 * the error can name the variable to change.
 */

export type EmbedOptions = {
  env: Env;
  /** Reused across calls by a caller that has one; created per call otherwise. */
  breaker?: CircuitBreaker;
  usage?: UsageSink;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export class EmbeddingDimensionError extends Error {
  override readonly name = 'EmbeddingDimensionError';

  constructor(
    readonly expected: number,
    readonly actual: number,
    readonly model: string,
  ) {
    super(
      `${model} returned ${actual}-dimensional vectors but chunks.embedding is ` +
        `vector(${expected}). Set EMBEDDING_DIMENSIONS and the column to the same ` +
        'width, then reindex every document — a mixed index returns nonsense ' +
        'rather than failing.',
    );
  }
}

type EmbeddingResponse = {
  data?: { embedding?: number[]; index?: number }[];
  usage?: { prompt_tokens?: number; total_tokens?: number };
};

/**
 * Embed a batch of texts, in the order they were given.
 *
 * The provider is asked to return `index` with each vector and the result is
 * re-sorted by it: the OpenAI API documents input order, but a proxy in the
 * middle is under no such obligation, and a batch silently transposed would
 * attach every chunk's vector to its neighbour's text. That is a bug with no
 * symptom except worse retrieval.
 */
export async function embedTexts(
  texts: readonly string[],
  options: EmbedOptions,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const model = resolveModel(options.env, 'embedding');
  const started = Date.now();
  let attempts = 0;

  const response = await withResilience(
    {
      role: 'embedding',
      attempts: options.env.MODEL_MAX_RETRIES,
      breaker: options.breaker,
    },
    async (attempt) => {
      attempts = attempt;
      return requestEmbeddings(texts, model, options);
    },
  );

  const vectors = orderedVectors(response, texts.length, model.model);

  for (const vector of vectors) {
    if (vector.length !== model.dimensions) {
      throw new EmbeddingDimensionError(model.dimensions, vector.length, model.model);
    }
  }

  const promptTokens = response.usage?.prompt_tokens ?? response.usage?.total_tokens ?? 0;
  (options.usage ?? logUsage)({
    role: 'embedding',
    provider: model.provider,
    model: model.model,
    items: texts.length,
    promptTokens,
    completionTokens: 0,
    durationMs: Date.now() - started,
    attempts,
    costUsd: estimateCostUsd(model.model, promptTokens, 0),
  });

  return vectors;
}

/** Embed one string. The Phase 09 query path's whole use of this module. */
export async function embedQuery(text: string, options: EmbedOptions): Promise<number[]> {
  const [vector] = await embedTexts([text], options);
  if (vector === undefined) {
    throw new ModelCallError('the embedding provider returned no vector for the query', {
      role: 'embedding',
      retryable: true,
    });
  }
  return vector;
}

async function requestEmbeddings(
  texts: readonly string[],
  model: ResolvedModel,
  options: EmbedOptions,
): Promise<EmbeddingResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(model.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);

  const body: Record<string, unknown> = { model: model.model, input: [...texts] };
  // Only OpenAI's own endpoint takes `dimensions` (Matryoshka truncation of
  // `text-embedding-3-*`). Sending it to Ollama or vLLM is a 400 from a server
  // that has never heard of it, so the width is requested where it can be and
  // verified everywhere.
  if (model.provider === 'openai') body.dimensions = model.dimensions;

  let response: Response;
  try {
    response = await fetchImpl(`${model.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(model.apiKey === undefined ? {} : { authorization: `Bearer ${model.apiKey}` }),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    // A transport failure — DNS, a refused connection, the timeout above — is
    // the provider being unreachable, which is exactly the retryable case.
    throw new ModelCallError('the embedding provider could not be reached', {
      role: 'embedding',
      retryable: true,
      cause: error,
    });
  }

  if (!response.ok) {
    // The body is read but not forwarded verbatim: a provider echoing the
    // input back inside an error message would put document text into a log
    // line, and document text is untrusted data that never reaches telemetry.
    await response.text().catch(() => '');
    throw new ModelCallError(
      `the embedding provider answered ${response.status} ${response.statusText}`,
      { role: 'embedding', status: response.status, retryable: isRetryableStatus(response.status) },
    );
  }

  return (await response.json()) as EmbeddingResponse;
}

function orderedVectors(response: EmbeddingResponse, expected: number, model: string): number[][] {
  const data = response.data ?? [];
  if (data.length !== expected) {
    throw new ModelCallError(`${model} returned ${data.length} vectors for ${expected} inputs`, {
      role: 'embedding',
      retryable: true,
    });
  }

  // `Array.from` rather than `new Array(expected)`: the latter is *sparse*, and
  // `some` and `forEach` skip holes in a sparse array — so a provider that
  // returned two entries with the same index would leave a hole that the gap
  // check below silently walked past and the dimension check then dereferenced.
  const vectors: (number[] | undefined)[] = Array.from({ length: expected });

  data.forEach((entry, position) => {
    const index = entry.index ?? position;
    const vector = entry.embedding;
    if (vector === undefined || !Number.isInteger(index) || index < 0 || index >= expected) {
      throw new ModelCallError(`${model} returned a malformed embedding entry`, {
        role: 'embedding',
        retryable: true,
      });
    }
    vectors[index] = vector;
  });

  const complete: number[][] = [];
  for (const vector of vectors) {
    if (vector === undefined) {
      throw new ModelCallError(`${model} returned a batch with a gap in it`, {
        role: 'embedding',
        retryable: true,
      });
    }
    complete.push(vector);
  }

  return complete;
}

/** A breaker configured from the environment, for a caller that makes many calls. */
export function breakerFor(env: Env): CircuitBreaker {
  return new CircuitBreaker({
    failures: env.MODEL_BREAKER_FAILURES,
    cooldownMs: env.MODEL_BREAKER_COOLDOWN_SECONDS * 1000,
  });
}
