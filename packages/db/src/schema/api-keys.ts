import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { ID_PREFIXES, newId } from '../id.js';
import { organizations } from './organizations.js';

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId(ID_PREFIXES.apiKey)),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    hashedKey: text('hashed_key').notNull(),
    prefix: text('prefix').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('api_keys_org_id_idx').on(table.orgId)],
);
