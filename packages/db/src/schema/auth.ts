import { index, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { ID_PREFIXES, newId } from '../id.js';
import { membershipRoleEnum } from './memberships.js';
import { organizations } from './organizations.js';
import { users } from './users.js';

/**
 * The tables Better Auth owns.
 *
 * Konusbitr does not let Better Auth generate its own schema. The product
 * tables — `users`, `organizations`, `memberships` — were defined in Phase 03
 * and are what documents, chunks and credits reference, so Better Auth is
 * pointed at them through the `modelName`/`fields` mapping in
 * `apps/web/src/lib/auth/config.ts`. What remains here is the set of tables
 * that exist purely to run sessions and sign-in, plus `invitations`, which the
 * organization plugin owns end to end.
 *
 * Two consequences are worth stating, because they are easy to get wrong later:
 *
 * - Every field name below is a *Drizzle property* name that the Better Auth
 *   Drizzle adapter looks up by string. Renaming `expiresAt` to `expires` here
 *   breaks sign-in at runtime, not at compile time — the mapping in
 *   `config.ts` is the only thing that ties the two together, and it is
 *   covered by an integration test.
 * - Ids are ours (`newId`), not Better Auth's, because `advanced.database.
 *   generateId` is wired to the same helper. A `ses_…` in a log is a session.
 */

/** Lifecycle of a team invitation, mirroring the organization plugin's values. */
export const invitationStatusEnum = pgEnum('invitation_status', [
  'pending',
  'accepted',
  'rejected',
  'canceled',
]);

/**
 * A signed-in browser session.
 *
 * `activeOrganizationId` is the tenancy pointer: it is what `AuthContext.orgId`
 * resolves to for a cookie principal, and what the org switcher writes. It is
 * nullable only for the instant between a user row and its first membership;
 * `resolveAuthContext` treats a session without one as unauthenticated rather
 * than guessing an org.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId(ID_PREFIXES.session)),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    activeOrganizationId: text('active_organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sessions_token_idx').on(table.token),
    index('sessions_user_id_idx').on(table.userId),
  ],
);

/**
 * A credential attached to a user: one row per OAuth provider, plus one row
 * with `providerId = 'credential'` holding the scrypt password hash.
 *
 * Nothing in this table is ever returned to a client — Better Auth marks the
 * token columns `returned: false` — and nothing in it is ever logged; see
 * `redact.ts`.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId(ID_PREFIXES.account)),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('accounts_user_id_idx').on(table.userId),
    uniqueIndex('accounts_provider_account_idx').on(table.providerId, table.accountId),
  ],
);

/**
 * Short-lived tokens: email verification, password reset and magic links.
 *
 * Rows here are single-use and expire; Better Auth deletes them on
 * consumption, so the table stays small without a sweeper.
 */
export const verifications = pgTable(
  'verifications',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId(ID_PREFIXES.verification)),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
);

/**
 * A pending invitation to join an organization.
 *
 * The invitee is identified by email rather than by user id, because the whole
 * point is to invite someone who may not have an account yet. Accepting is the
 * only path that turns a row here into a `memberships` row.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId(ID_PREFIXES.invitation)),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: membershipRoleEnum('role'),
    status: invitationStatusEnum('status').notNull().default('pending'),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('invitations_org_id_idx').on(table.orgId),
    index('invitations_email_idx').on(table.email),
  ],
);
