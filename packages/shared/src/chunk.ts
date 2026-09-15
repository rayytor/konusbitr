import { z } from 'zod';
import { BoundingBoxSchema } from './citation.js';

/**
 * The chunk contract: what a retrievable passage looks like once the chunker
 * has run over a parse artifact.
 *
 * Chunk quality dominates answer quality — more than model choice, more than
 * prompt wording — and most of the ways a chunker can be wrong are ways of
 * losing *location*. A passage that cannot say which page and which rectangle
 * it came from cannot be cited, and an answer that cannot be cited is the one
 * thing this product must never produce. So location is not metadata here: it
 * is a required field, and `pages` is never empty.
 *
 * These schemas describe rows in `chunks` and the JSON the Python chunker
 * writes into them. They do **not** cross the Redis seam — nothing here is
 * part of the generated pydantic contract — so the Python side mirrors the
 * shape rather than deriving it. `packages/shared/test/chunk.test.ts` pins the
 * literal JSON both halves agree on.
 */

/**
 * Where a chunk sits, as one rectangle on one page.
 *
 * A chunk that spans a page break has one entry per page it touches, in page
 * order, which is why this is a list rather than a single page number. The
 * Phase 03 schema had `page_no integer` plus a single `{x, y, width, height}`
 * box; both are gone, because a single box cannot describe a passage that
 * crosses a break and two coordinate shapes in one codebase is how a viewer
 * ends up drawing a highlight in the wrong place.
 *
 * `bbox` is the one canonical convention: PDF points, origin top-left, y
 * downward, unrotated page, ordered `[x0, y0, x1, y1]`. See
 * `docs/coordinates.md`.
 */
export const ChunkPageSchema = z.object({
  page: z.number().int().positive(),
  bbox: BoundingBoxSchema,
});

export type ChunkPage = z.infer<typeof ChunkPageSchema>;

/**
 * One cell of a table, addressable by position and locatable on the page.
 *
 * `bbox` is what makes a cell-level citation possible: "the 2024 revenue
 * figure" can be highlighted on the number rather than on the whole table.
 * It is optional because not every source produces it — a table whose cells
 * carry no provenance is still a table — and `rowSpan`/`colSpan` are omitted
 * when they are 1, so an ordinary table's JSON is not mostly boilerplate.
 *
 * `rowIndex` counts the header row as row 0, matching `rows` holding the data
 * rows alone: the header cell of a column is the one with `rowIndex === 0`.
 */
export const ChunkTableCellSchema = z.object({
  rowIndex: z.number().int().nonnegative(),
  colIndex: z.number().int().nonnegative(),
  text: z.string(),
  bbox: BoundingBoxSchema.optional(),
  rowSpan: z.number().int().positive().default(1),
  colSpan: z.number().int().positive().default(1),
  header: z.boolean().default(false),
});

export type ChunkTableCell = z.infer<typeof ChunkTableCellSchema>;

/**
 * A table as data, carried through from the parse artifact.
 *
 * `numRows` counts the header row; `numCols` is the widest row. Both are
 * derivable from `headers` and `rows` and are stored anyway, because Phase 13's
 * `extract` answers "how big is this table?" without walking it and because a
 * consumer that reads only the dimensions should not have to know the counting
 * rule.
 *
 * Every field except `headers` and `rows` has a default. Artifacts written
 * before Phase 12.2 carry only those two, and a parse from the docId cache is
 * years-old JSON by design — so reading one must produce a valid table rather
 * than a validation error.
 */
export const ChunkTableSchema = z.object({
  numRows: z.number().int().nonnegative().optional(),
  numCols: z.number().int().nonnegative().optional(),
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  cells: z.array(ChunkTableCellSchema).default([]),
});

export type ChunkTable = z.infer<typeof ChunkTableSchema>;

/**
 * Why a chunk has the size it does.
 *
 * `prose` is the ordinary case and is the only kind the token band applies to.
 * `table` is a chunk that exists because a table may never be split, so its
 * size is the table's size and not a choice the chunker made. `figure` is a
 * vision model's description of an extracted image, kept whole for the same
 * reason and cited against the figure's own rectangle — so that an answer drawn
 * from a chart points at the chart.
 */
export const CHUNK_KINDS = ['prose', 'table', 'figure'] as const;

export const ChunkKindSchema = z.enum(CHUNK_KINDS);

export type ChunkKind = z.infer<typeof ChunkKindSchema>;

/**
 * The sidecar the chunker stores in `chunks.meta`.
 *
 * Deliberately small, and deliberately all things a *reader* of a retrieved
 * chunk needs: which elements it came from (so a citation can be traced back
 * to the parse artifact), the table as data when the chunk is a table (so
 * Phase 13's `extract` can address a cell without re-parsing prose), and
 * whether the chunker had to cut something off.
 */
export const ChunkMetaSchema = z.object({
  kind: ChunkKindSchema.default('prose'),
  /** Ids of the parse-artifact elements this chunk was built from, in order. */
  elementIds: z.array(z.string()).default([]),
  /** Present when the chunk is a table. `nullish`, because the worker writes `null`. */
  tableJson: ChunkTableSchema.nullish(),
  /** True when content was dropped to fit the embedding model's context. */
  truncated: z.boolean().default(false),
});

export type ChunkMeta = z.infer<typeof ChunkMetaSchema>;

/** A chunk as a retrieval result or an API response renders it. */
export const ChunkViewSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  /** Position in the document, 0-based. Unique per document; upserts key on it. */
  ordinal: z.number().int().nonnegative(),
  /** `Financials > Revenue`, or `null` for content above the first heading. */
  sectionPath: z.string().nullable(),
  text: z.string(),
  tokenCount: z.number().int().nonnegative(),
  /** At least one entry, always. */
  pages: z.array(ChunkPageSchema).min(1),
  meta: ChunkMetaSchema.nullish(),
});

export type ChunkView = z.infer<typeof ChunkViewSchema>;

/**
 * The chunker's shape, as both runtimes default it.
 *
 * Every value here is overridable by an environment variable of the same name
 * upper-snake-cased, validated by `EnvSchema` on the TypeScript side and by
 * `konusbitr_worker.settings` on the Python side. The defaults are declared
 * here so that the two halves cannot drift apart silently: the chunker runs in
 * Python, but a Phase 09 query that needs to know how big a chunk is supposed
 * to be reads this.
 *
 * The band is 600–900 tokens because it is the range where a passage is long
 * enough to answer a question on its own and short enough that eight of them
 * fit in a prompt with room for an answer. The 15% overlap is what keeps a
 * sentence that straddles a boundary retrievable from either side.
 */
export const CHUNKING_DEFAULTS = Object.freeze({
  /** Aim for this many tokens per chunk. */
  targetTokens: 800,
  /** Below this, a chunk is merged into its neighbour when one will take it. */
  minTokens: 600,
  /** Hard ceiling for a prose chunk; a merge that would exceed it is refused. */
  maxTokens: 1100,
  /** Fraction of the previous chunk's tail repeated at the head of the next. */
  overlapRatio: 0.15,
  /**
   * Headings at or above this level end a chunk.
   *
   * `2` means a chunk never crosses an `#` or `##` boundary unless a single
   * section is larger than `maxTokens`, which is the point: a retrieved
   * passage that mixes two top-level sections answers questions about neither.
   */
  boundaryHeadingLevel: 2,
});

/** The separator between breadcrumb segments in `sectionPath` and chunk text. */
export const SECTION_PATH_SEPARATOR = ' > ';

/**
 * The marker left behind when content had to be dropped.
 *
 * Explicit and in the chunk text, not only in metadata: whatever reads the
 * chunk — a model, a person looking at a citation — has to be able to tell
 * that it is looking at part of a table rather than all of one.
 */
export const TRUNCATION_MARKER = '[… truncated to fit the embedding model context …]';

/**
 * Render a breadcrumb from a heading trail.
 *
 * Returns `null` rather than an empty string for content that sits above the
 * first heading, so the column is honestly empty rather than holding `''`.
 */
export function formatSectionPath(trail: readonly string[]): string | null {
  const parts = trail.map((part) => part.trim()).filter((part) => part.length > 0);
  return parts.length === 0 ? null : parts.join(SECTION_PATH_SEPARATOR);
}

/**
 * The union of a set of per-page boxes, one rectangle per page.
 *
 * A chunk carries the union rather than every element's box because a
 * highlight is drawn per page: three paragraphs on page 4 are one region to
 * light up, and storing three boxes would have the viewer draw three
 * overlapping rectangles. Pages come back in ascending order so the first
 * entry is where a citation should scroll to.
 */
export function unionChunkPages(entries: readonly ChunkPage[]): ChunkPage[] {
  const byPage = new Map<number, [number, number, number, number]>();

  for (const entry of entries) {
    const current = byPage.get(entry.page);
    const [x0, y0, x1, y1] = entry.bbox;
    if (current === undefined) {
      byPage.set(entry.page, [x0, y0, x1, y1]);
      continue;
    }
    current[0] = Math.min(current[0], x0);
    current[1] = Math.min(current[1], y0);
    current[2] = Math.max(current[2], x1);
    current[3] = Math.max(current[3], y1);
  }

  return [...byPage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([page, bbox]) => ({
      page,
      bbox: [...bbox] as [number, number, number, number],
    }));
}
