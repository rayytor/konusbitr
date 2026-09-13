import type { ChunkPage } from '@konusbitr/shared';
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

/**
 * Mark an address verified, the way clicking the emailed link would.
 *
 * The end-to-end run signs up through the real form and then needs a verified
 * account. The alternative is scraping the verification link out of the
 * server's log, which couples a test to a log format and stops working the
 * moment SMTP is configured — so the test does to the column what the link
 * would have done, and everything else about sign-in stays real.
 */
export async function markEmailVerified(db: Database, email: string): Promise<void> {
  await db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.email, email));
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
  input: {
    documentId?: string | null;
    contentHash: string;
    settingsHash: string;
    pageCount?: number;
  },
) {
  await db.insert(schema.parseResults).values({
    documentId: input.documentId ?? null,
    contentHash: input.contentHash,
    settingsHash: input.settingsHash,
    pageCount: input.pageCount ?? 1,
    markdown: '# parsed',
  });

  if (input.documentId) {
    await db
      .update(schema.documents)
      .set({ status: 'ready', pageCount: input.pageCount ?? 1 })
      .where(eq(schema.documents.id, input.documentId));
  }
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

/**
 * Write a chunk directly, so a delete can be shown to take it with the document.
 *
 * `ordinal` and `pages` are not optional in the Phase 08 schema — a chunk with
 * no location cannot be cited, so the column is `NOT NULL` — which means even a
 * cascade test has to supply both.
 */
export async function seedChunk(
  db: Database,
  input: { documentId: string; orgId: string; ordinal?: number; pages?: ChunkPage[] },
) {
  await db.insert(schema.chunks).values({
    documentId: input.documentId,
    orgId: input.orgId,
    ordinal: input.ordinal ?? 0,
    pages: input.pages ?? [{ page: 1, bbox: [72, 72, 540, 120] }],
    text: 'a chunk that should not survive its document',
    tokenCount: 9,
  });
}

/**
 * The declared dimension of `chunks.embedding`, read back from the catalogue.
 *
 * Asserted by the schema integration test because it is a number that lives in
 * three places at once — the DDL, `EMBEDDING_DIMENSIONS` in `@konusbitr/shared`,
 * and the `EMBEDDING_DIMENSIONS` environment variable — and a mismatch between
 * them surfaces as an insert failing inside a batch rather than as a
 * configuration error.
 */
export async function embeddingColumnDimensions(db: Database): Promise<number> {
  const rows = await db.execute<{ dims: number }>(sql`
    SELECT atttypmod AS dims
      FROM pg_attribute
     WHERE attrelid = 'chunks'::regclass
       AND attname = 'embedding'
  `);
  const [row] = rows as unknown as { dims: number }[];
  if (row === undefined) throw new Error('chunks.embedding does not exist');
  return row.dims;
}
