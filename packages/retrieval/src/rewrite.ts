import { completeChat, loadPrompt } from '@konusbitr/ai';
import type { RetrieveOptions } from './types.js';

const rewriteCache = new Map<string, string>();

/** Test-only helper to clear the query rewrite cache. */
export function clearRewriteCache(): void {
  rewriteCache.clear();
}

/**
 * Collapse conversational history into a standalone retrieval query.
 *
 * - Skips when there is no history.
 * - Caches by (conversationId, turn) or history content.
 * - Falls back to the raw query on any model failure or missing configuration.
 */
export async function rewriteQuery(options: RetrieveOptions): Promise<string> {
  const { query, history, conversationId, turn, env } = options;

  if (!history || history.length === 0) {
    return query;
  }

  const cacheKey =
    conversationId && turn !== undefined
      ? `${conversationId}:${turn}`
      : `${query}:${JSON.stringify(history)}`;

  const cached = rewriteCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  if (!env) {
    return query;
  }

  try {
    const promptTemplate = loadPrompt('chat.rewrite.v1');
    const conversationContext = history.map((msg) => `${msg.role}: ${msg.content}`).join('\n');

    const messages = [
      { role: 'system' as const, content: promptTemplate },
      {
        role: 'user' as const,
        content: `Conversation History:\n${conversationContext}\n\nLatest Question:\n${query}`,
      },
    ];

    const rewritten = await completeChat(messages, { env, temperature: 0 });
    const result = rewritten && rewritten.length > 0 ? rewritten : query;
    rewriteCache.set(cacheKey, result);
    return result;
  } catch {
    // Fall back to the raw query rather than erroring
    return query;
  }
}
