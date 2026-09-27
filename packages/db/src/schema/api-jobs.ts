import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { ID_PREFIXES, newId } from '../id.js';
import { documents } from './documents.js';
import { organizations } from './organizations.js';

/**
 * An `?async=true` operation on the public `/v2` API.
 *
 * Deliberately **not** the `jobs` table. The two look similar and mean
 * different things: a `jobs` row is a unit of work for the Python pipeline and
 * is keyed to a document that must already exist, while one of these is a
 * *request* — it exists from the moment a caller sends one, before any document
 * does, and it can be an `extract` or an `ask` that the pipeline knows nothing
 * about. Folding them together would mean a `NOT NULL document_id` that half
 * the rows could not satisfy, and a worker switching on a `type` it must never
 * be handed.
 *
 * The row is also the durable copy of the answer. A webhook is a notification,
 * retried a handful of times and then given up on, because the body is always
 * here to be fetched from `GET /v2/jobs/:jobId`. That is what keeps the
 * delivery policy short instead of turning our retry budget into a fund for
 * somebody else's downtime.
 */
export const apiJobs = pgTable(
  'api_jobs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId(ID_PREFIXES.apiJob)),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Which endpoint: `parse`, `extract`, `split` or `ask`. */
    kind: text('kind').notNull(),
    /** `pending` → `running` → `succeeded` | `failed`. */
    status: text('status').notNull().default('pending'),
    /**
     * The document the operation is about, once one exists.
     *
     * Null until intake has created it, and `ON DELETE SET NULL` rather than
     * cascade: deleting a document should not silently erase the record of the
     * extraction somebody ran against it and is still holding a job id for.
     */
    documentId: text('document_id').references(() => documents.id, { onDelete: 'set null' }),
    /** 0–100, mirroring the pipeline's own progress while a parse runs. */
    progress: integer('progress').notNull().default(0),
    /** The endpoint's ordinary response body, on success. */
    result: jsonb('result').$type<Record<string, unknown>>(),
    /** The same `{ code, message, details?, requestId }` a sync call would return. */
    error: jsonb('error').$type<Record<string, unknown>>(),
    /**
     * Where to POST the result. Passed through the SSRF guard before it is
     * stored, so a row here is a destination that was allowed at request time.
     */
    webhookUrl: text('webhook_url'),
    /** Deliveries made, and how the last one went. For an operator, not a client. */
    webhookAttempts: integer('webhook_attempts').notNull().default(0),
    webhookStatus: text('webhook_status'),
    /** The `X-Request-Id` of the call that created this, for log correlation. */
    requestId: text('request_id'),
    /** The API key that submitted it, when the caller used one. */
    apiKeyId: text('api_key_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('api_jobs_org_created_idx').on(table.orgId, table.createdAt),
    index('api_jobs_status_idx').on(table.status),
  ],
);

export type ApiJobRow = typeof apiJobs.$inferSelect;
