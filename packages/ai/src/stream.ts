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
};

/**
 * Resolve and instantiate the AI SDK LanguageModel for the 'chat' role.
 */
export function getChatLanguageModel(env: Env, options?: { fetchImpl?: typeof fetch }) {
  const resolved = resolveModel(env, 'chat');
  const provider = createOpenAI({
    baseURL: resolved.baseUrl,
    apiKey: resolved.apiKey ?? 'not-needed',
    fetch: options?.fetchImpl,
  });

  return {
    model: provider(resolved.model) as LanguageModel,
    resolved,
  };
}

/**
 * Execute a streaming chat completion using Vercel AI SDK v5 streamText.
 */
export function streamChat(options: StreamChatOptions) {
  const { model } = getChatLanguageModel(options.env, {
    fetchImpl: options.fetchImpl,
  });

  return streamText({
    model,
    system: options.system,
    messages: options.messages,
    temperature: options.temperature ?? 0.1,
    abortSignal: options.abortSignal,
  });
}
