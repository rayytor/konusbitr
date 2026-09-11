import { z } from 'zod';

/**
 * A rectangle on a page, in Konusbitr's single coordinate convention:
 * PDF user-space points, origin **top-left**, y increasing downward, on the
 * unrotated page. The worker normalizes every parser's output into this
 * convention so the viewer only ever applies a scale factor.
 *
 * Ordered `[x0, y0, x1, y1]` with `x0 <= x1` and `y0 <= y1`.
 */
export const BoundingBoxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .describe('[x0, y0, x1, y1] in PDF points, origin top-left, y down, unrotated page');

export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

/**
 * A grounded reference from an answer back into a source document.
 *
 * `quote` is verified mechanically against the parse result for `page` before a
 * citation is allowed to reach a client; unverifiable citations are dropped.
 */
export const CitationSchema = z.object({
  /** Verbatim span from the document that supports the claim. */
  quote: z.string().min(1),
  /** 1-based page number within the source document. */
  page: z.number().int().positive(),
  /** Where the quote sits on the page, for viewer highlighting. */
  bbox: BoundingBoxSchema,
  /** Id of the retrieved chunk the quote came from (`chk_…`). */
  chunkId: z.string().min(1),
  /** JSON Pointer into an extraction result, when the citation supports a field. */
  schemaPath: z.string().optional(),
});

export type Citation = z.infer<typeof CitationSchema>;
