import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from '../src/fusion.js';
import type { RetrievedChunk } from '../src/types.js';

function makeChunk(id: string, docId: string = 'doc_1', text: string = 'text'): RetrievedChunk {
  return {
    id,
    documentId: docId,
    ordinal: 0,
    text,
    score: 1.0,
    sectionPath: null,
    pages: [{ page: 1, bbox: [0, 0, 100, 100] }],
    page: 1,
    bbox: [0, 0, 100, 100],
  };
}

describe('reciprocalRankFusion (RRF)', () => {
  it('combines two ranked lists and ranks overlapping documents higher', () => {
    const listA = [makeChunk('chk_1'), makeChunk('chk_2'), makeChunk('chk_3')];
    const listB = [makeChunk('chk_2'), makeChunk('chk_4'), makeChunk('chk_1')];

    // chk_1 has rank 1 in A (1/61) and rank 3 in B (1/63) -> sum ~0.03226
    // chk_2 has rank 2 in A (1/62) and rank 1 in B (1/61) -> sum ~0.03252
    // chk_2 should beat chk_1
    const fused = reciprocalRankFusion([listA, listB], { k: 60 });

    expect(fused[0]?.id).toBe('chk_2');
    expect(fused[1]?.id).toBe('chk_1');
    expect(fused.map((c) => c.id)).toContain('chk_3');
    expect(fused.map((c) => c.id)).toContain('chk_4');
  });

  it('handles empty lists gracefully', () => {
    const listA = [makeChunk('chk_1')];
    const fused = reciprocalRankFusion([listA, []], { k: 60 });
    expect(fused).toHaveLength(1);
    expect(fused[0]?.id).toBe('chk_1');

    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it('respects the candidate limit', () => {
    const list = Array.from({ length: 100 }, (_, i) => makeChunk(`chk_${i}`));
    const fused = reciprocalRankFusion([list], { limit: 50 });
    expect(fused).toHaveLength(50);
  });
});
