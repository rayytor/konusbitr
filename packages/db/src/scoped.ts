import { and, asc, desc, eq, gt, isNull, or } from 'drizzle-orm';
import type { Database } from './client.js';
import { ID_PREFIXES, newId } from './id.js';
import * as schema from './schema/index.js';

/**
 * Org-scoped query helpers.
 *
 * Every query path in Konusbitr goes through `scopedDb(db, orgId)` to ensure
 * multi-tenancy is enforced at the data-access layer, not sprinkled across
 * route handlers. This is a load-bearing invariant — see CLAUDE.md.
 *
 * The helpers return pre-filtered query builders so callers cannot accidentally
 * omit the org filter. The underlying Drizzle `db` is also exposed for the
 * rare cases (migrations, admin tooling) that need unscoped access.
 */
export function scopedDb(db: Database, orgId: string) {
  if (!orgId) {
    throw new Error('scopedDb requires a non-empty orgId');
  }

  return {
    /** The raw Drizzle client — use only when org scoping is handled elsewhere. */
    raw: db,

    /** The orgId this scope is bound to. */
    orgId,

    /** Query documents belonging to this org. */
    documents() {
      return db.select().from(schema.documents).where(eq(schema.documents.orgId, orgId));
    },

    /** Query chunks belonging to this org. */
    chunks() {
      return db.select().from(schema.chunks).where(eq(schema.chunks.orgId, orgId));
    },

    /** Query conversations belonging to this org. */
    conversations() {
      return db.select().from(schema.conversations).where(eq(schema.conversations.orgId, orgId));
    },

    /** Query jobs belonging to this org. */
    jobs() {
      return db.select().from(schema.jobs).where(eq(schema.jobs.orgId, orgId));
    },

    /** Query folders belonging to this org. */
    folders() {
      return db.select().from(schema.folders).where(eq(schema.folders.orgId, orgId));
    },

    /** Query API keys belonging to this org. */
    apiKeys() {
      return db.select().from(schema.apiKeys).where(eq(schema.apiKeys.orgId, orgId));
    },

    /** Every API key ever issued to this org, newest first, revoked ones included. */
    listApiKeys() {
      return db
        .select()
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.orgId, orgId))
        .orderBy(desc(schema.apiKeys.createdAt));
    },

    /**
     * Store a new API key. The caller generates the secret and hands over only
     * its hash and prefix — this layer never sees a raw key.
     */
    async createApiKey(input: {
      name: string;
      hashedKey: string;
      prefix: string;
      scopes: string[];
      expiresAt?: Date | null;
    }) {
      const [row] = await db
        .insert(schema.apiKeys)
        .values({
          id: newId(ID_PREFIXES.apiKey),
          orgId,
          name: input.name,
          hashedKey: input.hashedKey,
          prefix: input.prefix,
          scopes: input.scopes,
          expiresAt: input.expiresAt ?? null,
        })
        .returning();
      return row;
    },

    /**
     * Revoke a key, returning `undefined` when there was no live key with that
     * id *in this org*. The org predicate is what stops an admin of one
     * organization from revoking another's key by guessing an id.
     */
    async revokeApiKey(keyId: string) {
      const [row] = await db
        .update(schema.apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.apiKeys.id, keyId),
            eq(schema.apiKeys.orgId, orgId),
            isNull(schema.apiKeys.revokedAt),
          ),
        )
        .returning({ id: schema.apiKeys.id });
      return row;
    },

    /** This user's role in this org, or `undefined` if they are not a member. */
    async membershipOf(userId: string) {
      const [row] = await db
        .select({ role: schema.memberships.role })
        .from(schema.memberships)
        .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.orgId, orgId)))
        .limit(1);
      return row;
    },

    /** Query memberships belonging to this org. */
    memberships() {
      return db.select().from(schema.memberships).where(eq(schema.memberships.orgId, orgId));
    },

    /** Query pending and settled invitations belonging to this org. */
    invitations() {
      return db.select().from(schema.invitations).where(eq(schema.invitations.orgId, orgId));
    },

    /** Query extractions belonging to this org. */
    extractions() {
      return db.select().from(schema.extractions).where(eq(schema.extractions.orgId, orgId));
    },

    /** Query credit ledger entries belonging to this org. */
    creditLedger() {
      return db.select().from(schema.creditLedger).where(eq(schema.creditLedger.orgId, orgId));
    },
  };
}

export type ScopedDb = ReturnType<typeof scopedDb>;
