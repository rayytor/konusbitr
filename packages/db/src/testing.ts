import { asc, eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { ID_PREFIXES, newId } from './id.js';
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

/**
 * Create an organization directly.
 *
 * Sign-up normally does this through Better Auth, which is the right path for
 * the auth tests. A test about documents wants a tenant, not a login flow.
 */
export async function createOrganization(db: Database, name: string, slug: string) {
  const [row] = await db
    .insert(schema.organizations)
    .values({ id: newId(ID_PREFIXES.organization), name, slug })
    .returning();
  if (!row) throw new Error('the organization could not be created');
  return row;
}

/**
 * Stand in for the worker by recording a finished parse.
 *
 * Phase 05 ends by enqueuing a job that nothing consumes, so the only way to
 * test what a *completed* parse does to the docId cache is to write the row the
 * worker will write in Phase 07.
 */
export async function recordParseResult(
  db: Database,
  input: { documentId: string; contentHash: string; settingsHash: string; pageCount?: number },
) {
  await db.insert(schema.parseResults).values({
    documentId: input.documentId,
    contentHash: input.contentHash,
    settingsHash: input.settingsHash,
    pageCount: input.pageCount ?? 1,
    markdown: '# parsed',
  });

  await db
    .update(schema.documents)
    .set({ status: 'ready', pageCount: input.pageCount ?? 1 })
    .where(eq(schema.documents.id, input.documentId));
}

/** Every job recorded for a document, so a test can assert none was created. */
export async function jobsForDocument(db: Database, documentId: string) {
  return db.select().from(schema.jobs).where(eq(schema.jobs.documentId, documentId));
}

/** Every credit-ledger entry an organization has accrued, newest last. */
export async function creditEntriesOf(db: Database, orgId: string) {
  return db
    .select()
    .from(schema.creditLedger)
    .where(eq(schema.creditLedger.orgId, orgId))
    .orderBy(asc(schema.creditLedger.createdAt));
}

/** The parse results recorded for a document — one, if the cache is working. */
export async function parseResultsForDocument(db: Database, documentId: string) {
  return db
    .select()
    .from(schema.parseResults)
    .where(eq(schema.parseResults.documentId, documentId));
}

/** A document's page geometry, oldest page first. */
export async function pagesForDocument(db: Database, documentId: string) {
  return db
    .select()
    .from(schema.pages)
    .where(eq(schema.pages.documentId, documentId))
    .orderBy(asc(schema.pages.pageNo));
}

/** Rows in a table that reference a document, for asserting a cascade. */
export async function chunksForDocument(db: Database, documentId: string) {
  return db.select().from(schema.chunks).where(eq(schema.chunks.documentId, documentId));
}

/** Write a chunk directly, so a delete can be shown to take it with the document. */
export async function seedChunk(db: Database, input: { documentId: string; orgId: string }) {
  await db.insert(schema.chunks).values({
    documentId: input.documentId,
    orgId: input.orgId,
    text: 'a chunk that should not survive its document',
    tokenCount: 9,
  });
}
