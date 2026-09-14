import { integer, pgTable, real, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { ID_PREFIXES, newId } from '../id.js';
import { documents } from './documents.js';

/**
 * How a page's text was obtained.
 *
 * A property of the page rather than of the document, which is Phase 12.1's
 * first idea: a hundred-page filing with three scanned exhibits is neither a
 * digital document nor a scanned one, and tiering it as either means
 * ninety-seven pages of needless recognition or three pages of silence.
 *
 * Mirrors `PageTier` in
 * `services/worker/src/konusbitr_worker/parse/artifact.py`, which is what
 * writes this column. `vlm` is declared before Phase 12.3 fills it in so that
 * the column's vocabulary does not change under rows that already exist.
 */
export const PAGE_TIERS = ['native', 'ocr', 'vlm'] as const;
export type PageTier = (typeof PAGE_TIERS)[number];

export const pages = pgTable(
  'pages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId(ID_PREFIXES.page)),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    pageNo: integer('page_no').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    thumbnailKey: text('thumbnail_key'),
    tier: text('tier', { enum: PAGE_TIERS }).notNull().default('native'),
    /**
     * `0.00`-`1.00` for a recognised page; `NULL` for a born-digital one.
     *
     * `NULL` rather than `1.0`, and the distinction is not pedantic. A native
     * page has no confidence because nothing guessed — the characters are the
     * ones in the file. Storing `1.0` would make "how confident are we in this
     * page?" a question with an answer everywhere, and on a born-digital page
     * the honest answer is that it is not a question. The viewer badges on
     * `tier`, and reads this only when there is something to read.
     */
    ocrConfidence: real('ocr_confidence'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('pages_document_page_idx').on(table.documentId, table.pageNo)],
);
