import { describe, expect, it } from 'vitest';
import {
  CHUNK_KINDS,
  CHUNKING_DEFAULTS,
  ChunkMetaSchema,
  type ChunkPage,
  ChunkViewSchema,
  formatSectionPath,
  unionChunkPages,
} from '../src/chunk.js';

describe('formatSectionPath', () => {
  it('joins a heading trail with the breadcrumb separator', () => {
    expect(formatSectionPath(['Financials', 'Revenue'])).toBe('Financials > Revenue');
  });

  it('is null for content above the first heading', () => {
    // Null rather than '': the column is honestly empty, and a retrieval
    // result that prepends '' > to its text is worse than one that prepends
    // nothing.
    expect(formatSectionPath([])).toBeNull();
    expect(formatSectionPath(['  ', ''])).toBeNull();
  });
});

describe('unionChunkPages', () => {
  it('collapses several boxes on one page into the region to highlight', () => {
    const entries: ChunkPage[] = [
      { page: 4, bbox: [72, 100, 300, 140] },
      { page: 4, bbox: [72, 160, 520, 210] },
    ];

    expect(unionChunkPages(entries)).toEqual([{ page: 4, bbox: [72, 100, 520, 210] }]);
  });

  it('keeps one entry per page for a chunk that crosses a page break', () => {
    const entries: ChunkPage[] = [
      { page: 9, bbox: [72, 640, 520, 700] },
      { page: 8, bbox: [72, 500, 520, 700] },
      { page: 9, bbox: [72, 90, 520, 120] },
    ];

    // Ascending, so the first entry is where a citation scrolls to.
    expect(unionChunkPages(entries)).toEqual([
      { page: 8, bbox: [72, 500, 520, 700] },
      { page: 9, bbox: [72, 90, 520, 700] },
    ]);
  });

  it('returns nothing for nothing', () => {
    expect(unionChunkPages([])).toEqual([]);
  });
});

describe('the chunk contract', () => {
  it('refuses a chunk with no location', () => {
    // The load-bearing rule of this phase: a passage that cannot say where it
    // came from cannot be cited, and an uncitable answer is the one thing the
    // product must never produce.
    const result = ChunkViewSchema.safeParse({
      id: 'chk_abc',
      documentId: 'doc_abc',
      ordinal: 0,
      sectionPath: null,
      text: 'Revenue grew.',
      tokenCount: 3,
      pages: [],
    });

    expect(result.success).toBe(false);
  });

  it('accepts the shape the Python chunker writes, nulls included', () => {
    // The worker serialises an unset optional as JSON `null`, never as an
    // absent key — pydantic has no spelling for `undefined` — so every
    // optional here has to be `nullish`.
    const parsed = ChunkViewSchema.parse({
      id: 'chk_abc',
      documentId: 'doc_abc',
      ordinal: 3,
      sectionPath: 'Financials > Revenue',
      text: 'Financials > Revenue\n\nRevenue grew 18% year over year.',
      tokenCount: 742,
      pages: [{ page: 4, bbox: [72, 100, 520, 210] }],
      meta: { kind: 'prose', elementIds: ['el_0007'], tableJson: null, truncated: false },
    });

    expect(parsed.meta?.tableJson).toBeNull();
    expect(parsed.pages[0]?.page).toBe(4);
  });

  it('accepts the table JSON the Phase 12.2 worker writes, cells and all', () => {
    // Held as a literal rather than built, because this is the shape the Python
    // half emits and the two runtimes share no code. If `TableData.to_json`
    // changes, this is what notices.
    const parsed = ChunkMetaSchema.parse({
      kind: 'table',
      elementIds: ['el_0104'],
      truncated: false,
      tableJson: {
        numRows: 3,
        numCols: 3,
        headers: ['Metric', 'Q3 2024', 'Q3 2025'],
        rows: [
          ['Revenue', '$12.4M', '$18.2M'],
          ['Net Income', '$2.1M', '$4.3M'],
        ],
        cells: [
          { rowIndex: 0, colIndex: 0, text: 'Metric', bbox: [58, 120, 180, 140], header: true },
          { rowIndex: 1, colIndex: 0, text: 'Revenue', bbox: [58, 160, 180, 180] },
          { rowIndex: 0, colIndex: 1, text: 'Quarter', bbox: [180, 120, 550, 140], colSpan: 2 },
        ],
      },
    });

    expect(parsed.tableJson?.numRows).toBe(3);
    expect(parsed.tableJson?.cells[1]?.rowSpan).toBe(1);
    expect(parsed.tableJson?.cells[2]?.colSpan).toBe(2);
    expect(parsed.tableJson?.cells[0]?.header).toBe(true);
  });

  it('reads a table written before Phase 12.2 without complaining', () => {
    // A parse from the docId cache is years-old JSON by design: the cache key
    // is the file's bytes, so a document parsed under an older worker is read
    // back verbatim rather than re-parsed. Every field the newer worker adds
    // therefore has to be optional on the way in.
    const parsed = ChunkMetaSchema.parse({
      kind: 'table',
      tableJson: { headers: ['Segment', '2024'], rows: [['Services', '2,110']] },
    });

    expect(parsed.tableJson?.cells).toEqual([]);
    expect(parsed.tableJson?.numRows).toBeUndefined();
  });

  it('knows a figure chunk from a prose one', () => {
    // A figure chunk is a vision model's description of an extracted image,
    // kept whole so that an answer drawn from a chart cites the chart.
    expect(ChunkMetaSchema.parse({ kind: 'figure', elementIds: ['img_001'] }).kind).toBe('figure');
    expect(CHUNK_KINDS).toEqual(['prose', 'table', 'figure']);
  });

  it('defaults chunk metadata to an ordinary prose chunk', () => {
    expect(ChunkMetaSchema.parse({})).toEqual({
      kind: 'prose',
      elementIds: [],
      truncated: false,
    });
  });
});

describe('the chunking band', () => {
  it('is ordered min <= target <= max', () => {
    // Not a tautology: these three are the defaults for four environment
    // variables, and a band whose floor sits above its target makes every
    // chunk undersized.
    expect(CHUNKING_DEFAULTS.minTokens).toBeLessThanOrEqual(CHUNKING_DEFAULTS.targetTokens);
    expect(CHUNKING_DEFAULTS.targetTokens).toBeLessThanOrEqual(CHUNKING_DEFAULTS.maxTokens);
    expect(CHUNKING_DEFAULTS.overlapRatio).toBeGreaterThan(0);
    expect(CHUNKING_DEFAULTS.overlapRatio).toBeLessThan(0.5);
  });
});
