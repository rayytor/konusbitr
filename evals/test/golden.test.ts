import { describe, expect, it } from 'vitest';
import { buildEvalChunks, loadFixtureCorpus } from '../src/corpus.js';
import { aggregate, loadGoldenSet, scoreOne } from '../src/eval-retrieval.js';

const golden = loadGoldenSet();
const corpus = loadFixtureCorpus();

describe('the golden set', () => {
  it('has at least the 200 items the phase asks for', () => {
    expect(golden.length).toBeGreaterThanOrEqual(200);
  });

  it('names a document the fixture corpus actually contains', () => {
    for (const item of golden) {
      expect(Object.keys(corpus)).toContain(item.documentId);
    }
  });

  it('expects only pages that exist in that document', () => {
    for (const item of golden) {
      const pages = corpus[item.documentId] ?? [];
      const available = new Set(pages.map((page) => page.page));
      expect(item.expectedPages.length).toBeGreaterThan(0);
      for (const page of item.expectedPages) {
        expect(available.has(page)).toBe(true);
      }
    }
  });

  it('is answerable: every answer has some evidence on an expected page', () => {
    // The guarantee `generate-golden.ts` enforces when it writes the file. It is
    // re-asserted here because it is the property that makes the whole eval mean
    // anything: the earlier golden set asked about the fixture generator's
    // source — the gutter width, the paragraph count, the `/Rotate 90` flag —
    // none of which appears in any document, so no retrieval system could score.
    const ungrounded = golden.filter((item) => {
      const pages = corpus[item.documentId] ?? [];
      const expected = new Set(item.expectedPages);
      return !pages.some((page) => expected.has(page.page) && page.text.trim().length > 0);
    });
    expect(ungrounded).toEqual([]);
  });

  it('spreads across every readable fixture rather than testing one document', () => {
    const documents = new Set(golden.map((item) => item.documentId));
    expect(documents.size).toBe(Object.keys(corpus).length);
  });
});

describe('the eval corpus', () => {
  it('gives every chunk a page, because a chunk that cannot say where it came from cannot be cited', () => {
    for (const chunk of buildEvalChunks(corpus)) {
      expect(chunk.pages.length).toBeGreaterThan(0);
      for (const page of chunk.pages) {
        expect(page.page).toBeGreaterThanOrEqual(1);
        expect(page.bbox).toHaveLength(4);
      }
    }
  });

  it('keeps each page-mode chunk attributed to the page it was cut from', () => {
    const chunks = buildEvalChunks(corpus);
    for (const chunk of chunks) {
      const pages = corpus[chunk.documentId] ?? [];
      const source = pages.find((page) => page.page === chunk.pages[0]?.page);
      expect(source).toBeDefined();
      // The chunk's opening words have to appear on the page it claims.
      const opening = chunk.text.slice(0, 40);
      expect(source?.text).toContain(opening);
    }
  });

  it('shreds text and smears provenance in broken mode, which is the point of it', () => {
    const healthy = buildEvalChunks(corpus, 'page');
    const shredded = buildEvalChunks(corpus, 'shredded');

    expect(shredded.length).toBeGreaterThan(healthy.length * 2);

    const misattributed = shredded.filter((chunk) => {
      const pages = corpus[chunk.documentId] ?? [];
      const claimed = pages.find((page) => page.page === chunk.pages[0]?.page);
      return !claimed?.text.includes(chunk.text.slice(0, 30));
    });
    expect(misattributed.length).toBeGreaterThan(0);
  });
});

describe('scoring', () => {
  const item = {
    question: 'q',
    documentId: 'doc',
    expectedPages: [4],
    answer: 'a',
  };
  const chunk = (id: string, documentId: string, page: number) => ({
    id,
    documentId,
    ordinal: 0,
    text: 't',
    score: 1,
    sectionPath: null,
    pages: [{ page, bbox: [0, 0, 1, 1] as [number, number, number, number] }],
    page,
    bbox: [0, 0, 1, 1] as [number, number, number, number],
  });

  it('counts a hit only when the document and the page both match', () => {
    // The page is not decoration: it is what a citation points at, so the right
    // text retrieved from the wrong page is a miss.
    expect(scoreOne(item, [chunk('a', 'doc', 4)]).hit).toBe(true);
    expect(scoreOne(item, [chunk('a', 'doc', 5)]).hit).toBe(false);
    expect(scoreOne(item, [chunk('a', 'other', 4)]).hit).toBe(false);
  });

  it('rewards a higher rank', () => {
    const first = scoreOne(item, [chunk('a', 'doc', 4), chunk('b', 'other', 1)]);
    const second = scoreOne(item, [chunk('b', 'other', 1), chunk('a', 'doc', 4)]);
    expect(first.reciprocalRank).toBe(1);
    expect(second.reciprocalRank).toBe(0.5);
  });

  it('ignores anything past rank 8', () => {
    const filler = Array.from({ length: 8 }, (_, i) => chunk(`f${i}`, 'other', 1));
    expect(scoreOne(item, [...filler, chunk('a', 'doc', 4)]).hit).toBe(false);
  });

  it('reports zeroes rather than NaN for an empty run', () => {
    expect(aggregate([])).toEqual({
      recallAt8: 0,
      mrr: 0,
      contextPrecision: 0,
      totalQuestions: 0,
    });
  });
});
