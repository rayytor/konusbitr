import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { ID_PREFIXES, newId } from '../id.js';
import { documents } from './documents.js';

/**
 * Parse results table — the **docId cache**.
 *
 * The `UNIQUE (content_hash, settings_hash)` constraint is the single biggest
 * cost lever in the product: a repeat upload with the same file and parse
 * settings returns `ready` in milliseconds with zero credits and no job.
 *
 * `document_id` records initial provenance (which upload first produced the
 * parse), not ownership. The row is a cache entry keyed on hashes across tenants;
 * when that first document is deleted, `document_id` is set to NULL rather than
 * cascading, preserving the cache entry for any other documents that share it.
 */
export const parseResults = pgTable(
  'parse_results',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId(ID_PREFIXES.parseResult)),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'set null' }),
    contentHash: text('content_hash').notNull(),
    settingsHash: text('settings_hash').notNull(),
    quality: text('quality').notNull().default('standard'),
    langList: text('lang_list').array().notNull().default([]),
    llmEnabled: boolean('llm_enabled').notNull().default(false),
    markdown: text('markdown'),
    contents: jsonb('contents').$type<Record<string, unknown>>(),
    pageCount: integer('page_count'),
    /**
     * How far the ingest that is building this row has got, or NULL when it is
     * finished. See `JobCheckpointSchema` in `@konusbitr/shared`.
     *
     * This column is what makes a long parse resumable *without* weakening the
     * docId cache, and the rule is one sentence: **a row with a checkpoint is
     * not a cache entry.** The worker writes its accumulated elements here
     * after every page batch, so a container killed at page 850 of 900 finds
     * 850 pages of parse waiting for it — and until the final batch sets this
     * back to NULL, no other upload can hit the cache and be handed a document
     * that is missing its last fifty pages.
     */
    checkpoint: jsonb('checkpoint').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('parse_results_cache_idx').on(table.contentHash, table.settingsHash)],
);
