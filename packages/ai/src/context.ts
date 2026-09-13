import type { ChunkPage } from '@konusbitr/shared';
import type { ChatMessage } from './chat.js';

export type GroundedChunk = {
  id: string;
  documentId?: string;
  ordinal?: number;
  score?: number;
  text: string;
  pages: ChunkPage[];
  page?: number;
  sectionPath?: string | null;
};

/**
 * Build the grounded context string from retrieved chunks.
 *
 * Each chunk is formatted with its identity tag:
 * [[chk_01HQ…, p42]]
 * Financials > Revenue (if sectionPath present)
 * Passage text...
 */
export function buildContext(chunks: readonly GroundedChunk[]): string {
  if (chunks.length === 0) {
    return 'No relevant document context found.';
  }

  return chunks
    .map((chunk) => {
      const page = chunk.page ?? chunk.pages[0]?.page ?? 1;
      const tag = `[[${chunk.id}, p${page}]]`;
      const header = chunk.sectionPath ? `${chunk.sectionPath}\n` : '';
      return `${tag}\n${header}${chunk.text.trim()}`;
    })
    .join('\n\n');
}

/**
 * Approximate token count for a text string (roughly 4 characters per token).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Window conversation history by token budget. Older messages are dropped or summarized
 * if they exceed the budget (default 4096 tokens).
 */
export function windowHistory(
  messages: readonly ChatMessage[],
  maxTokens = 4096,
): { windowed: ChatMessage[]; hasTrimmed: boolean } {
  if (messages.length === 0) {
    return { windowed: [], hasTrimmed: false };
  }

  let totalTokens = 0;
  const result: ChatMessage[] = [];

  // Iterate backwards from most recent turn
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    const tokens = estimateTokens(msg.content);

    if (totalTokens + tokens > maxTokens && result.length > 0) {
      return {
        windowed: result.reverse(),
        hasTrimmed: true,
      };
    }
    result.push(msg);
    totalTokens += tokens;
  }

  return {
    windowed: result.reverse(),
    hasTrimmed: false,
  };
}
