import { completeChat, loadPrompt } from '@konusbitr/ai';
import type { Env } from '@konusbitr/shared';

/**
 * Expand a query into three retrieval queries: the original, plus up to two
 * model-generated variants.
 *
 * Three total is what the phase asks for, so the model's output is trimmed to
 * two — the original always leads, because a paraphrase that drifts should not
 * be able to displace what the user actually typed.
 */
export async function generateQueryVariants(query: string, env: Env): Promise<string[]> {
  try {
    const promptTemplate = loadPrompt('chat.multiquery.v1');
    const messages = [
      { role: 'system' as const, content: promptTemplate },
      { role: 'user' as const, content: query },
    ];
    const text = await completeChat(messages, { env, temperature: 0.7 });
    const variants = text
      .split('\n')
      .map((line) => line.replace(/^[\d.-]+\s*/, '').trim())
      .filter((line) => line.length > 0 && line !== query)
      .slice(0, 2);

    return [query, ...variants];
  } catch {
    return [query];
  }
}
