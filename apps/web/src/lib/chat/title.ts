import { completeChat, loadPrompt } from '@konusbitr/ai';
import { scopedDb } from '@konusbitr/db';
import { db } from '@/lib/db';
import { loadWebEnv } from '@/lib/env';

/**
 * Generate and persist an auto-title for a conversation asynchronously.
 * Fire-and-forget: failure to generate a title does not interrupt chat flow.
 */
export async function autoTitleConversation(
  conversationId: string,
  userMessage: string,
  assistantAnswer: string,
  orgId: string,
): Promise<string | null> {
  try {
    const env = loadWebEnv();
    const system = loadPrompt('chat.title.v1');
    const prompt = `User question: ${userMessage.slice(0, 500)}\nAssistant answer: ${assistantAnswer.slice(0, 500)}`;

    const title = await completeChat(
      [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      {
        env,
        temperature: 0.2,
      },
    );

    const cleanTitle = title
      .replace(/^["'\s]+|["'\s]+$/g, '')
      .slice(0, 100)
      .trim();
    if (cleanTitle) {
      const scoped = scopedDb(db(), orgId);
      await scoped.updateConversationTitle(conversationId, cleanTitle);
      return cleanTitle;
    }
  } catch (error) {
    // Non-fatal: log and proceed
    console.warn(`[chat] auto-title failed for conversation ${conversationId}:`, error);
  }
  return null;
}
