import type { ChunkMeta, ChunkPage } from '@konusbitr/shared';
import { sql } from 'drizzle-orm';
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { ID_PREFIXES, newId } from '../id.js';
import { documents } from './documents.js';
import { organizations } from './organizations.js';

/**
 * pgvector `vector` column type.
 *
 * Drizzle doesn't ship a built-in vector column yet, so we define a custom one.
 * The dimension is passed at schema-definition time and baked into the DDL.
 *
 * **It must stay a fixed width.** pgvector can only build an HNSW or IVFFlat
 * index over a column whose dimension it knows: `CREATE INDEX … USING hnsw
 * (embedding vector_cosine_ops)` on an untyped `vector` fails outright with
 * "column does not have dimensions". So "let each deployment pick its own
 * embedding width" is not a thing this column can express, and the answer is
 * instead that every supported embedding model is used at 1024 — BGE-M3's
 * native width, and a width `text-embedding-3-large` supports through
 * Matryoshka truncation. See `EMBEDDING_DIMENSIONS` in `@konusbitr/shared`.
 */
export const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1024})`;
  },
  fromDriver(value) {
    // postgres.js delivers vector columns as strings like "[0.1,0.2,...]"
    return value.slice(1, -1).split(',').map(Number);
  },
  toDriver(value) {
    return `[${value.join(',')}]`;
  },
});

/**
 * Custom `tsvector` column type for full-text search.
 *
 * Used as a generated column: `to_tsvector('simple', text)`. Uses the
 * `simple` configuration rather than `english` because the corpus is
 * multilingual.
 */
const tsvector = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * Chunks table — the core of the retrieval index.
 *
 * `org_id` is denormalized here so retrieval filters never need a join.
 * The `tsv` column is a generated `tsvector` for BM25-style keyword search.
 *
 * Two columns carry the weight of this phase.
 *
 * `ordinal` is the chunk's position in its document, and `UNIQUE (document_id,
 * ordinal)` is what makes embedding idempotent: the worker upserts on that
 * pair, so a job re-delivered after a crash overwrites the chunks it had
 * already written instead of appending a second copy of them. Delivery is
 * at-least-once, so "exactly once" has to be a property of the write.
 *
 * `pages` is the location, and it replaces the Phase 03 `page_no` + `bbox`
 * pair. A single page number cannot describe a passage that crosses a page
 * break, and the old `{x, y, width, height}` box was a second coordinate shape
 * in a codebase whose central invariant is that there is exactly one. It is
 * `NOT NULL` because a chunk that cannot say where it came from cannot be
 * cited, and an uncitable answer is the failure this product exists to avoid.
 */
export const chunks = pgTable(
  'chunks',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId(ID_PREFIXES.chunk)),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Position in the document, 0-based. The other half of the upsert key. */
    ordinal: integer('ordinal').notNull(),
    /** `Financials > Revenue`, prepended to `text` as well as stored here. */
    sectionPath: text('section_path'),
    text: text('text').notNull(),
    tokenCount: integer('token_count').notNull(),
    /**
     * One rectangle per page the chunk touches, in page order:
     * `[{ page, bbox: [x0, y0, x1, y1] }]` in the single coordinate convention
     * of `docs/coordinates.md`. Never empty.
     */
    pages: jsonb('pages').$type<ChunkPage[]>().notNull(),
    /** The chunker's sidecar: kind, source element ids, table JSON, truncation. */
    meta: jsonb('meta').$type<ChunkMeta>(),
    embedding: vector('embedding', { dimensions: 1024 }),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('simple', "text")`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // HNSW index for dense vector retrieval (cosine similarity)
    index('chunks_embedding_idx')
      .using('hnsw', sql`${table.embedding} vector_cosine_ops`)
      .with({ m: 16, ef_construction: 64 }),

    // GIN index for full-text keyword search
    index('chunks_tsv_idx').using('gin', table.tsv),

    // The idempotency key. Unique, not merely indexed: it is what an upsert
    // conflicts on, so a second delivery of an embed job cannot double a
    // document's chunks however the first one ended.
    uniqueIndex('chunks_document_ordinal_idx').on(table.documentId, table.ordinal),

    index('chunks_org_id_idx').on(table.orgId),
  ],
);

/** A chunk row as it comes back from a select. */
export type ChunkRow = typeof chunks.$inferSelect;
