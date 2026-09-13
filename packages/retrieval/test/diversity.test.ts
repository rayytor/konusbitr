import { describe, expect, it } from 'vitest';
import { applyDiversityCap } from '../src/diversity.js';
import type { RetrievedChunk } from '../src/types.js';

function makeChunk(id: string, docId: string): RetrievedChunk {
  return {
    id,
    documentId: docId,
    ordinal: 0,
    text: `Text of ${id}`,
    score: 1.0,
    sectionPath: null,
    pages: [{ page: 1, bbox: [0, 0, 100, 100] }],
    page: 1,
    bbox: [0, 0, 100, 100],
  };
}

describe('applyDiversityCap', () => {
  it('does not limit chunks when scope is a single document', () => {
    const chunks = [
      makeChunk('chk_1', 'doc_1'),
      makeChunk('chk_2', 'doc_1'),
      makeChunk('chk_3', 'doc_1'),
      makeChunk('chk_4', 'doc_1'),
      makeChunk('chk_5', 'doc_1'),
    ];

    const result = applyDiversityCap(chunks, { kind: 'document', documentId: 'doc_1' }, 8);
    expect(result).toHaveLength(5);
  });

  it('caps chunks to at most 3 per document in corpus mode', () => {
    const chunks = [
      makeChunk('chk_1', 'doc_verbose'),
      makeChunk('chk_2', 'doc_verbose'),
      makeChunk('chk_3', 'doc_verbose'),
      makeChunk('chk_4', 'doc_verbose'), // Should be skipped!
      makeChunk('chk_5', 'doc_verbose'), // Should be skipped!
      makeChunk('chk_6', 'doc_other'),
      makeChunk('chk_7', 'doc_other'),
      makeChunk('chk_8', 'doc_third'),
    ];

    const result = applyDiversityCap(chunks, { kind: 'corpus' }, 8, 3);
    expect(result).toHaveLength(6);
    expect(result.map((c) => c.id)).toEqual(['chk_1', 'chk_2', 'chk_3', 'chk_6', 'chk_7', 'chk_8']);

    const docVerboseCount = result.filter((c) => c.documentId === 'doc_verbose').length;
    expect(docVerboseCount).toBe(3);
  });
});
