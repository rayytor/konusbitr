/**
 * `@konusbitr/db` — Drizzle schema, migrations and the scoped client.
 *
 * Every SQL query in Konusbitr goes through Drizzle here; no other package
 * talks to Postgres, and no query path bypasses the `scopedDb(orgId)` helper
 * this package owns.
 */

export type { Database } from './client.js';

// Client
export { createDb } from './client.js';
export type { IdPrefix } from './id.js';
// ID generation
export { ID_PREFIXES, newId } from './id.js';
// Migrations
export { migrate } from './migrate.js';
// Schema tables
export {
  accounts,
  apiKeys,
  chunks,
  conversations,
  creditLedger,
  documents,
  extractions,
  folders,
  invitationStatusEnum,
  invitations,
  jobs,
  membershipRoleEnum,
  memberships,
  messages,
  organizations,
  pages,
  parseResults,
  sessions,
  users,
  verifications,
} from './schema/index.js';
export type { ScopedDb } from './scoped.js';
// Multi-tenancy
export { scopedDb } from './scoped.js';
