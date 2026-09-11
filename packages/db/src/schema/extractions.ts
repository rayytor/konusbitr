import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { ID_PREFIXES, newId } from '../id.js';
import { documents } from './documents.js';
import { organizations } from './organizations.js';

export const extractions = pgTable('extractions', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => newId(ID_PREFIXES.extraction)),
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  documentId: text('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  schema: jsonb('schema').$type<Record<string, unknown>>(),
  result: jsonb('result').$type<Record<string, unknown>>(),
  citations: jsonb('citations').$type<Record<string, unknown>[]>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
