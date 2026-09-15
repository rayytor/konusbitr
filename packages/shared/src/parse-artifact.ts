import { z } from 'zod';
import { BoundingBoxSchema } from './citation.js';

/**
 * The parts of the parse artifact that TypeScript reads.
 *
 * The artifact is produced by the Python worker and stored as the `contents`
 * `jsonb` column of `parse_results`. It does **not** cross the Redis seam — no
 * message carries it — so nothing here is generated from anything and nothing
 * generates anything: the Python side declares the same shape in
 * `services/worker/src/konusbitr_worker/parse/`, and
 * `packages/shared/test/parse-artifact.test.ts` pins the literal JSON both
 * halves agree on. That is the same arrangement `chunk.ts` uses, for the same
 * reason: a shared ORM or a shared access layer across the two runtimes is the
 * thing this architecture exists to avoid.
 *
 * Only the pieces a TypeScript consumer actually reads are described. The
 * element stream is the chunker's input and the chunker is Python; what the web
 * app and the Phase 13 API need out of the artifact is where the figures are.
 */

/**
 * One image extracted from a document and stored, as Phase 12.2 writes it.
 *
 * `storageKey` is the object key the worker wrote, under the layout
 * `documentImageKey` in `packages/storage/src/keys.ts` builds — the worker
 * derives it from generated ids and never from user input, exactly as it does
 * for thumbnails.
 *
 * `caption` is the vision model's description, present only when the upload
 * asked for one with `llm: true` *and* a vision role was configured. `null` is
 * the ordinary case and is not a degraded one: the figure is still extracted,
 * stored and locatable, it is simply not searchable. It is `nullable` rather
 * than optional because the worker writes an explicit `null` — an unset
 * `str | None` serialises to JSON `null` in pydantic and `undefined` has no
 * JSON spelling.
 *
 * `width` and `height` are the stored image's pixels, which is not the same as
 * `bbox`'s size: an image placed at a quarter of its native resolution has a
 * small rectangle and a large bitmap, and a viewer needs both — one to draw the
 * region on the page, the other to know what it will get if it fetches the file.
 */
export const ExtractedImageSchema = z.object({
  /** `img_001`. Zero-padded so a lexical sort is an extraction-order sort. */
  id: z.string(),
  /** 1-indexed page the figure sits on. */
  page: z.number().int().positive(),
  /** The figure's rectangle, in the one convention. See `docs/coordinates.md`. */
  bbox: BoundingBoxSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  storageKey: z.string().min(1),
  caption: z.string().nullable(),
});

export type ExtractedImage = z.infer<typeof ExtractedImageSchema>;
