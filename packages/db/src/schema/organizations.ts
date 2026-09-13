import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { ID_PREFIXES, newId } from '../id.js';

export const organizations = pgTable(
  'organizations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId(ID_PREFIXES.organization)),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    logo: text('logo'),
    plan: text('plan').notNull().default('free'),
    creditBalance: integer('credit_balance').notNull().default(0),
    settings: jsonb('settings').$type<Record<string, unknown>>().default({}),
    /**
     * Better Auth's organization metadata, which it stores as a JSON *string*.
     * Deliberately separate from `settings`: that column is the product's own
     * JSONB and nothing outside Konusbitr may rewrite it.
     */
    metadata: text('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('organizations_slug_idx').on(table.slug)],
);

export type OrganizationRow = typeof organizations.$inferSelect;
