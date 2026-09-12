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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('parse_results_cache_idx').on(table.contentHash, table.settingsHash)],
);
