import { canResolveModel, rerankTexts } from '@konusbitr/ai';
import type { Env } from '@konusbitr/shared';
import type { RetrievedChunk } from './types.js';

export type RerankStageOptions = {
  query: string;
  candidates: RetrievedChunk[];
  topK: number;
  rerankEnabled?: boolean;
  env?: Env;
};

/**
 * Re-scores fused retrieval candidates using a cross-encoder model.
 *
 * If `rerankEnabled === false`, or if no rerank model is configured,
 * or if the reranker call encounters a failure, gracefully falls back to the
 * candidates in their existing RRF order.
 */
export async function applyReranking(options: RerankStageOptions): Promise<RetrievedChunk[]> {
  const { query, candidates, topK, rerankEnabled, env } = options;

  const isEnabled = rerankEnabled ?? env?.RERANK_ENABLED ?? true;
  if (!isEnabled || candidates.length === 0 || !env) {
    return candidates.slice(0, topK);
  }

  if (!canResolveModel(env, 'rerank')) {
    return candidates.slice(0, topK);
  }

  try {
    const documentTexts = candidates.map((c) => c.text);
    const rerankResults = await rerankTexts(query, documentTexts, {
      env,
      topN: candidates.length,
    });

    const scoreByIndex = new Map<number, number>();
    for (const res of rerankResults) {
      scoreByIndex.set(res.index, res.score);
    }

    const reranked = candidates.map((chunk, index) => ({
      ...chunk,
      score: scoreByIndex.get(index) ?? chunk.score,
    }));

    reranked.sort((a, b) => b.score - a.score);
    return reranked.slice(0, topK);
  } catch {
    // Fall back cleanly to RRF order
    return candidates.slice(0, topK);
  }
}
