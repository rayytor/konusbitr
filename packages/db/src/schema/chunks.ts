import { sql } from 'drizzle-orm';
import { customType, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { ID_PREFIXES, newId } from '../id.js';
import { documents } from './documents.js';
import { organizations } from './organizations.js';

/**
 * pgvector `vector` column type.
 *
 * Drizzle doesn't ship a built-in vector column yet, so we define a custom one.
 * The dimension is passed at schema-definition time and baked into the DDL.
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
    pageNo: integer('page_no'),
    sectionPath: text('section_path'),
    text: text('text').notNull(),
    tokenCount: integer('token_count').notNull(),
    bbox: jsonb('bbox').$type<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>(),
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

    // Btree indexes for filtering
    index('chunks_doc_page_idx').on(table.documentId, table.pageNo),
    index('chunks_org_id_idx').on(table.orgId),
  ],
);
