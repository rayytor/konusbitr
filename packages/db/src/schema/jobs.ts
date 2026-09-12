import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { ID_PREFIXES, newId } from '../id.js';
import { documents } from './documents.js';
import { organizations } from './organizations.js';

export const jobs = pgTable(
  'jobs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId(ID_PREFIXES.job)),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    status: text('status').notNull().default('pending'),
    progress: integer('progress').notNull().default(0),
    stage: text('stage'),
    error: text('error'),
    /** The same stable code that lands on the document. See `documents.errorCode`. */
    errorCode: text('error_code'),
    /**
     * Deliveries so far, first included.
     *
     * The queue is at-least-once, so this is the durable half of the retry
     * budget: the payload carries the attempt number, but only a row survives
     * a worker being killed between the failure and the re-enqueue.
     */
    attempts: integer('attempts').notNull().default(0),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    result: jsonb('result').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('jobs_org_status_idx').on(table.orgId, table.status)],
);
