import { index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { ID_PREFIXES, newId } from '../id.js';
import { folders } from './folders.js';
import { organizations } from './organizations.js';

/**
 * Document status lifecycle: queued → parsing → ocr → embedding → ready | failed.
 *
 * The status values match `DOCUMENT_STATUSES` in `@konusbitr/shared` exactly.
 * We store them as plain text rather than a pgEnum so that adding a new status
 * never requires an `ALTER TYPE`.
 */
export const documents = pgTable(
  'documents',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId(ID_PREFIXES.document)),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    folderId: text('folder_id').references(() => folders.id, {
      onDelete: 'set null',
    }),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    byteSize: integer('byte_size').notNull(),
    pageCount: integer('page_count'),
    storageKey: text('storage_key').notNull(),
    contentHash: text('content_hash').notNull(),
    /**
     * `sha256(canonical_json(parse settings))` — the other half of the docId
     * cache key. It lives on the document, not only on `parse_results`,
     * because the *identity* of a document is its bytes **and** the settings
     * they were parsed with: the same PDF at `quality: 'advanced'` is a
     * different `docId` with its own job, which is why the uniqueness below is
     * over all three columns.
     */
    settingsHash: text('settings_hash').notNull(),
    sourceUrl: text('source_url'),
    status: text('status').notNull().default('queued'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('documents_org_created_idx').on(table.orgId, table.createdAt),
    uniqueIndex('documents_org_content_settings_idx').on(
      table.orgId,
      table.contentHash,
      table.settingsHash,
    ),
  ],
);

/** A document row as it comes back from a select. */
export type DocumentRow = typeof documents.$inferSelect;
