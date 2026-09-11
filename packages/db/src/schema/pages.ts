import { integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { ID_PREFIXES, newId } from '../id.js';
import { documents } from './documents.js';

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('pages_document_page_idx').on(table.documentId, table.pageNo)],
);
