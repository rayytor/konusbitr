import { describe, expect, it } from 'vitest';
import {
  fuzzyIncludes,
  type GroundedChunk,
  levenshteinDistance,
  normalizeText,
  parseInlineCitationMarkers,
  parseStructuredCitations,
  removeCitationsBlock,
  stringSimilarity,
  verifyCitations,
} from '../src/citations.js';

describe('normalizeText', () => {
  it('collapses whitespace and normalizes quotes', () => {
    const raw = '  “Revenue” was   18%  higher\n\n year-over-year  ';
    expect(normalizeText(raw)).toBe('"revenue" was 18% higher year-over-year');
  });

  it('removes soft hyphens and zero width spaces', () => {
    const raw = 'super\u00ADcali\u200Bfragilistic';
    expect(normalizeText(raw)).toBe('supercalifragilistic');
  });

  it('merges words split by hyphenation across newlines', () => {
    const raw = 'in-\ncreased revenue in 2023';
    expect(normalizeText(raw)).toBe('increased revenue in 2023');
  });
});

describe('levenshtein & stringSimilarity', () => {
  it('computes accurate edit distance', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('same', 'same')).toBe(0);
  });

  it('computes similarity >= 0.85 for minor variations', () => {
    expect(stringSimilarity('subscription', 'subscripton')).toBeGreaterThan(0.85);
  });
});

describe('fuzzyIncludes', () => {
  it('detects exact substrings', () => {
    expect(fuzzyIncludes('total revenue was $4,120 million in q3', 'revenue was $4,120')).toBe(
      true,
    );
  });

  it('detects fuzzy substrings with minor ligature or OCR noise', () => {
    expect(
      fuzzyIncludes(
        'total revenue was 4,120 million in fiscal year 2023',
        'total revenue was 4,120 million in fiscal year 2023',
      ),
    ).toBe(true);
    expect(
      fuzzyIncludes(
        'total revenue was 4,120 million in fiscal year 2023',
        'total revenue was 4,120 million in fiscl year 2023',
      ),
    ).toBe(true);
  });

  it('rejects completely fabricated quotes', () => {
    expect(fuzzyIncludes('total revenue was 4,120 million', 'net loss was 500 million')).toBe(
      false,
    );
  });
});

describe('structured citations and markers', () => {
  it('parses valid structured citations', () => {
    const text = `The revenue grew [[chk_1, 3]].
<citations>
[
  {
    "chunkId": "chk_1",
    "page": 3,
    "quote": "revenue grew 18%"
  }
]
</citations>`;
    const parsed = parseStructuredCitations(text);
    expect(parsed).toEqual([
      {
        chunkId: 'chk_1',
        page: 3,
        quote: 'revenue grew 18%',
        documentId: undefined,
      },
    ]);
  });

  it('parses inline markers', () => {
    const text = 'Revenue grew 18% [[chk_1, 3]] and expenses dropped [[chk_2, p.4]].';
    const markers = parseInlineCitationMarkers(text);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({ chunkId: 'chk_1', page: 3 });
    expect(markers[1]).toMatchObject({ chunkId: 'chk_2', page: 4 });
  });

  it('removes citations block cleanly', () => {
    const text =
      'Answer content.\n<citations>\n[{"chunkId": "c", "page": 1, "quote": "q"}]\n</citations>';
    expect(removeCitationsBlock(text)).toBe('Answer content.');
  });
});

describe('verifyCitations mechanical verification', () => {
  const dummyChunk: GroundedChunk = {
    id: 'chk_rev_01',
    documentId: 'doc_123',
    ordinal: 0,
    text: 'Total revenue grew 18% year-over-year to $4,120 million in Q3 2023.',
    score: 0.95,
    sectionPath: 'Financials > Revenue',
    pages: [{ page: 3, bbox: [50, 100, 500, 150] }],
    page: 3,
    bbox: [50, 100, 500, 150],
  };

  it('verifies exact quote matches', () => {
    const text = `Revenue grew 18% [[chk_rev_01, 3]].
<citations>
[
  {
    "chunkId": "chk_rev_01",
    "page": 3,
    "quote": "revenue grew 18% year-over-year to $4,120 million"
  }
]
</citations>`;
    const res = verifyCitations(text, [dummyChunk]);
    expect(res.verified).toHaveLength(1);
    expect(res.rejected).toHaveLength(0);
    expect(res.verified[0]).toEqual({
      chunkId: 'chk_rev_01',
      page: 3,
      bbox: [50, 100, 500, 150],
      quote: 'revenue grew 18% year-over-year to $4,120 million',
      documentId: 'doc_123',
    });
  });

  it('rejects citations whose quote does not appear in chunk text', () => {
    const text = `Profits doubled [[chk_rev_01, 3]].
<citations>
[
  {
    "chunkId": "chk_rev_01",
    "page": 3,
    "quote": "profits doubled to $800 million"
  }
]
</citations>`;
    const res = verifyCitations(text, [dummyChunk]);
    expect(res.verified).toHaveLength(0);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]?.reason).toContain('Quote does not appear');
  });

  it('rejects citations referencing wrong page number', () => {
    const text = `Revenue grew 18% [[chk_rev_01, 99]].
<citations>
[
  {
    "chunkId": "chk_rev_01",
    "page": 99,
    "quote": "revenue grew 18%"
  }
]
</citations>`;
    const res = verifyCitations(text, [dummyChunk]);
    expect(res.verified).toHaveLength(0);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]?.reason).toContain('does not match chunk pages');
  });

  it('rejects citations for unknown chunk IDs', () => {
    const text = `Unknown data [[chk_unknown, 1]].
<citations>
[
  {
    "chunkId": "chk_unknown",
    "page": 1,
    "quote": "some text"
  }
]
</citations>`;
    const res = verifyCitations(text, [dummyChunk]);
    expect(res.verified).toHaveLength(0);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]?.reason).toContain('not found in retrieved chunks');
  });

  it('falls back to best matching sentence when model emits only inline marker', () => {
    const text = 'Total revenue grew 18% year-over-year [[chk_rev_01, 3]].';
    const res = verifyCitations(text, [dummyChunk]);
    expect(res.verified).toHaveLength(1);
    expect(res.verified[0]?.chunkId).toBe('chk_rev_01');
    expect(res.verified[0]?.quote).toContain('Total revenue grew 18%');
  });
});
