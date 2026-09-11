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
    status: text('status').notNull().default('queued'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('documents_org_created_idx').on(table.orgId, table.createdAt),
    uniqueIndex('documents_org_content_hash_idx').on(table.orgId, table.contentHash),
  ],
);
