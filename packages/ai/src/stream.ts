import { createOpenAI } from '@ai-sdk/openai';
import type { Env } from '@konusbitr/shared';
import { type LanguageModel, streamText } from 'ai';
import { resolveModel } from './roles.js';

export type StreamChatOptions = {
  env: Env;
  system: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  temperature?: number;
  abortSignal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Optional provider API key override (e.g. from workspace settings). */
  apiKey?: string;
  /**
   * Called when the provider fails partway through a stream.
   *
   * `streamText` deliberately does not throw from `textStream`: an error
   * mid-stream is handed to `onError` and the iterable simply ends. Without
   * this hook a 401 from the provider reaches the caller as a *successful*
   * empty answer — the same failure shape as a retrieval leg that swallows its
   * own exception, and the one a citation-grounded product can least afford,
   * because "the document does not say" and "the model never ran" become
   * indistinguishable. Callers are expected to surface what they are given.
   */
  onError?: (error: unknown) => void;
};

/**
 * Turn whatever `onError` handed us into an Error worth showing someone.
 *
 * The AI SDK reports a provider rejection as `AI_APICallError` whose `message`
 * is the bare HTTP reason — "Bad Request" — while the part that says what is
 * actually wrong ("Please pass a valid API key") sits in `responseBody`. That
 * message is the only thing the chat pane can show, and the difference between
 * it naming a missing key and it saying "Bad Request" is the difference
 * between a user fixing their `.env` and filing a bug.
 */
export function describeStreamError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));

  const detail = providerErrorDetail((error as { responseBody?: unknown }).responseBody);
  const status = (error as { statusCode?: unknown }).statusCode;
  if (detail === undefined) return error;

  const prefix = typeof status === 'number' ? `chat provider responded ${status}` : 'chat provider';
  const described = new Error(`${prefix}: ${detail}`, { cause: error });
  described.name = error.name;
  return described;
}

/**
 * The human-readable half of a provider's JSON error body.
 *
 * Providers disagree on the envelope — a bare object, or a single-element array
 * wrapping one — so both are unwrapped, and anything unrecognised falls back to
 * the raw text rather than being dropped.
 */
function providerErrorDetail(body: unknown): string | undefined {
  if (typeof body !== 'string' || body.trim() === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body.slice(0, 500);
  }

  const envelope = Array.isArray(parsed) ? parsed[0] : parsed;
  const message = (envelope as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof message === 'string' && message !== '' ? message : body.slice(0, 500);
}

/**
 * Resolve and instantiate the AI SDK LanguageModel for the 'chat' role.
 */
export function getChatLanguageModel(
  env: Env,
  options?: { fetchImpl?: typeof fetch; apiKey?: string },
) {
  const resolved = resolveModel(env, 'chat');
  const provider = createOpenAI({
    baseURL: resolved.baseUrl,
    apiKey: options?.apiKey ?? resolved.apiKey ?? 'not-needed',
    fetch: options?.fetchImpl,
  });

  return {
    model: provider.chat(resolved.model) as LanguageModel,
    resolved,
  };
}

/**
 * Execute a streaming chat completion using Vercel AI SDK v5 streamText.
 */
export function streamChat(options: StreamChatOptions) {
  const { model } = getChatLanguageModel(options.env, {
    fetchImpl: options.fetchImpl,
    apiKey: options.apiKey,
  });

  const { onError } = options;

  return streamText({
    model,
    system: options.system,
    messages: options.messages,
    temperature: options.temperature ?? 0.1,
    abortSignal: options.abortSignal,
    ...(onError === undefined ? {} : { onError: ({ error }) => onError(error) }),
  });
}
