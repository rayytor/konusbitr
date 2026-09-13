import type { RetrievedChunk, Scope } from './types.js';

/**
 * Enforce per-document diversity cap in corpus mode.
 *
 * In corpus scope ("chat with all PDFs"), ensures that no single document
 * contributes more than `maxChunksPerDoc` (default: 3) to prevent one verbose
 * PDF from dominating the results.
 */
export function applyDiversityCap(
  chunks: readonly RetrievedChunk[],
  scope: Scope,
  topK: number,
  maxChunksPerDoc: number = 3,
): RetrievedChunk[] {
  // Only applies when searching across a corpus / folder
  if (scope.kind === 'document') {
    return chunks.slice(0, topK);
  }

  const result: RetrievedChunk[] = [];
  const docCounts = new Map<string, number>();

  for (const chunk of chunks) {
    const currentCount = docCounts.get(chunk.documentId) ?? 0;
    if (currentCount < maxChunksPerDoc) {
      result.push(chunk);
      docCounts.set(chunk.documentId, currentCount + 1);
      if (result.length >= topK) {
        break;
      }
    }
  }

  return result;
}
