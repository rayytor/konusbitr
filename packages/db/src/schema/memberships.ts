import { index, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { ID_PREFIXES, newId } from '../id.js';
import { organizations } from './organizations.js';
import { users } from './users.js';

export const membershipRoleEnum = pgEnum('membership_role', ['owner', 'admin', 'member']);

/**
 * A user's place in an organization, and the only thing that grants access to
 * its documents.
 *
 * The natural key is `(user_id, org_id)` and it is still enforced — one
 * membership per user per org — but it is a unique index rather than the
 * primary key. Better Auth's organization plugin addresses its `member` rows by
 * a single `id`, so the table needs one; splitting the two keeps the plugin
 * working without weakening the invariant.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId(ID_PREFIXES.membership)),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: membershipRoleEnum('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('memberships_user_org_idx').on(table.userId, table.orgId),
    index('memberships_org_id_idx').on(table.orgId),
  ],
);
