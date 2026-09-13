import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { ID_PREFIXES, newId } from '../id.js';
import { vector } from './chunks.js';
import { documents } from './documents.js';
import { organizations } from './organizations.js';

/**
 * Document embeddings table — document-level vectors for two-stage retrieval.
 *
 * For large corpora (> `CORPUS_TWO_STAGE_THRESHOLD`, default 200 documents),
 * retrieval first searches these document-level summary embeddings to pick the
 * top 10 most relevant documents, and then performs chunk-level retrieval
 * within those candidates.
 */
export const documentEmbeddings = pgTable(
  'document_embeddings',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId(ID_PREFIXES.documentEmbedding)),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' })
      .unique(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    embedding: vector('embedding', { dimensions: 1024 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // HNSW index for dense vector retrieval over document summaries
    index('document_embeddings_embedding_idx')
      .using('hnsw', sql`${table.embedding} vector_cosine_ops`)
      .with({ m: 16, ef_construction: 64 }),

    index('document_embeddings_org_id_idx').on(table.orgId),
  ],
);

export type DocumentEmbeddingRow = typeof documentEmbeddings.$inferSelect;
