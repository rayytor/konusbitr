import { eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import * as schema from './schema/index.js';

/**
 * Helpers for tests that run against a throwaway Postgres.
 *
 * Exported from `@konusbitr/db/testing` rather than from the package root so
 * that nothing in the product can reach them by accident. They exist because
 * `apps/web` deliberately has no `drizzle-orm` dependency of its own — every
 * door to the database goes through this package — and a test still needs to
 * prepare a bare container and read a row back.
 */

/**
 * Create the extensions the schema depends on.
 *
 * In Compose this is done once by `docker/postgres/initdb`, before anything can
 * connect. A Testcontainers image has no such hook, so the migration would fail
 * on `vector(1024)` without this.
 */
export async function ensureExtensions(db: Database): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS unaccent`);
}

/** Read a user back by the address they signed up with. */
export async function userByEmail(db: Database, email: string) {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  return row;
}

/** Whether an organization still exists. */
export async function organizationExists(db: Database, orgId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);
  return rows.length > 0;
}
