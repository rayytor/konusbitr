import type { RetrievedChunk } from './types.js';

export type FusionOptions = {
  /** RRF smoothing constant (default: 60). */
  k?: number;
  /** Maximum number of fused candidates to retain (default: 50). */
  limit?: number;
};

/**
 * Fuse multiple ranked result lists using Reciprocal Rank Fusion (RRF).
 *
 * RRF score for a document d across ranked lists L:
 *   score(d) = sum_{m in L} 1 / (k + rank_m(d))
 *
 * Where rank_m(d) is 1-based rank.
 */
export function reciprocalRankFusion(
  rankedLists: readonly (readonly RetrievedChunk[])[],
  options: FusionOptions = {},
): RetrievedChunk[] {
  const { k = 60, limit = 50 } = options;

  const scoreMap = new Map<string, { chunk: RetrievedChunk; rrfScore: number }>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const chunk = list[rank];
      if (!chunk) {
        continue;
      }
      const rankScore = 1.0 / (k + (rank + 1));

      const existing = scoreMap.get(chunk.id);
      if (existing) {
        existing.rrfScore += rankScore;
      } else {
        scoreMap.set(chunk.id, {
          chunk,
          rrfScore: rankScore,
        });
      }
    }
  }

  const fused = [...scoreMap.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit)
    .map(({ chunk, rrfScore }) => ({
      ...chunk,
      score: rrfScore,
    }));

  return fused;
}
