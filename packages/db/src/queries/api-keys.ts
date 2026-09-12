import { and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import type { Database } from '../client.js';
import * as schema from '../schema/index.js';

/**
 * The queries that cannot go through `scopedDb`, in one reviewable place.
 *
 * Everything else in Konusbitr knows its organization before it queries, which
 * is why `scopedDb(orgId)` can be mandatory. Authenticating an API key is the
 * one inversion: the org is the *answer*, not the question. The same is true of
 * the two membership lookups below, which run while a session is being created
 * and therefore before there is an active organization to scope to.
 *
 * Isolating them here — rather than letting a route reach for the raw client —
 * keeps the exception small and named.
 */

export type ApiKeyRow = typeof schema.apiKeys.$inferSelect;

/**
 * Candidate keys sharing a presented key's non-secret prefix.
 *
 * Returns rows, not a decision: the caller still compares hashes in constant
 * time and checks revocation and expiry. Nothing here is proof that the
 * presented key is valid.
 */
export function findApiKeysByPrefix(db: Database, prefix: string): Promise<ApiKeyRow[]> {
  return db.select().from(schema.apiKeys).where(eq(schema.apiKeys.prefix, prefix));
}

/** Record that a key was used. Throttled by the caller; see `context.ts`. */
export async function touchApiKey(db: Database, keyId: string): Promise<void> {
  await db
    .update(schema.apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKeys.id, keyId));
}

/**
 * The organization a user should land in: their oldest membership.
 *
 * Takes a user id, so it can only ever return organizations that user belongs
 * to.
 */
export async function firstOrganizationOf(
  db: Database,
  userId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ orgId: schema.memberships.orgId })
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, userId))
    .orderBy(asc(schema.memberships.createdAt))
    .limit(1);
  return row?.orgId;
}

/** Every organization a user belongs to, with their role — for the org switcher. */
export function organizationsOf(db: Database, userId: string) {
  return db
    .select({
      id: schema.organizations.id,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
      role: schema.memberships.role,
    })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId))
    .where(eq(schema.memberships.userId, userId))
    .orderBy(asc(schema.memberships.createdAt));
}

/** Predicate matching the keys of an org that would authenticate right now. */
export function liveApiKey(orgId: string) {
  return and(
    eq(schema.apiKeys.orgId, orgId),
    isNull(schema.apiKeys.revokedAt),
    or(isNull(schema.apiKeys.expiresAt), gt(schema.apiKeys.expiresAt, new Date())),
  );
}
