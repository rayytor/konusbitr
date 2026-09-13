import type { Env } from '@konusbitr/shared';
import {
  type CircuitBreaker,
  isRetryableStatus,
  ModelCallError,
  withResilience,
} from './resilience.js';
import { type ResolvedModel, resolveModel } from './roles.js';
import { estimateCostUsd, logUsage, type UsageSink } from './usage.js';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ChatOptions = {
  env: Env;
  breaker?: CircuitBreaker;
  usage?: UsageSink;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  temperature?: number;
};

/**
 * Perform a non-streaming chat completion over the OpenAI-compatible route.
 *
 * Used by auxiliary retrieval tasks: query rewriting, HyDE generation, and
 * multi-query expansion.
 */
export async function completeChat(
  messages: readonly ChatMessage[],
  options: ChatOptions,
): Promise<string> {
  const model = resolveModel(options.env, 'chat');
  const started = Date.now();
  let attempts = 0;

  const content = await withResilience(
    {
      role: 'chat',
      attempts: options.env.MODEL_MAX_RETRIES,
      breaker: options.breaker,
    },
    async (attempt) => {
      attempts = attempt;
      return requestChatCompletion(messages, model, options);
    },
  );

  (options.usage ?? logUsage)({
    role: 'chat',
    provider: model.provider,
    model: model.model,
    items: 1,
    promptTokens: 0,
    completionTokens: 0,
    durationMs: Date.now() - started,
    attempts,
    costUsd: estimateCostUsd(model.model, 0, 0),
  });

  return content;
}

async function requestChatCompletion(
  messages: readonly ChatMessage[],
  model: ResolvedModel,
  options: ChatOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(model.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);

  const body: Record<string, unknown> = {
    model: model.model,
    messages: [...messages],
    temperature: options.temperature ?? 0.1,
  };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (model.apiKey !== undefined) {
    headers.authorization = `Bearer ${model.apiKey}`;
  }

  const url = model.baseUrl.endsWith('/v1')
    ? `${model.baseUrl}/chat/completions`
    : `${model.baseUrl}/v1/chat/completions`;

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
    throw new ModelCallError(`failed to reach ${model.provider} chat: ${message}`, {
      role: 'chat',
      cause: error,
      retryable: true,
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ModelCallError(
      `${model.provider} chat responded ${response.status}: ${text.slice(0, 200)}`,
      {
        role: 'chat',
        status: response.status,
        retryable: isRetryableStatus(response.status),
      },
    );
  }

  type OpenAIChatResponse = {
    choices?: Array<{
      message?: {
        content?: string | null;
      };
    }>;
  };

  const data = (await response.json()) as OpenAIChatResponse;
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') {
    throw new ModelCallError('chat provider returned no message content', {
      role: 'chat',
      retryable: true,
    });
  }

  return content.trim();
}
