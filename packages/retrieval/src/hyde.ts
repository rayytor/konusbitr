import { completeChat, loadPrompt } from '@konusbitr/ai';
import type { Env } from '@konusbitr/shared';

/**
 * Generate a hypothetical answer to a query using the chat model.
 *
 * Used for Hypothetical Document Embeddings (HyDE): embedding the hypothetical
 * document often aligns closer with corpus passage vectors than the question itself.
 */
export async function generateHydePassage(query: string, env: Env): Promise<string> {
  try {
    const promptTemplate = loadPrompt('chat.hyde.v1');
    const messages = [
      { role: 'system' as const, content: promptTemplate },
      { role: 'user' as const, content: query },
    ];
    const passage = await completeChat(messages, { env, temperature: 0.3 });
    return passage.trim() || query;
  } catch {
    // If HyDE generation fails, fall back cleanly to raw query
    return query;
  }
}
