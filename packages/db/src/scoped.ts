import { and, asc, desc, eq, gt, isNull, lt, or, type SQL } from 'drizzle-orm';
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

    /** Every member of this org with the user behind them, oldest first. */
    members() {
      return db
        .select({
          id: schema.memberships.id,
          userId: schema.users.id,
          email: schema.users.email,
          name: schema.users.name,
          role: schema.memberships.role,
          createdAt: schema.memberships.createdAt,
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(eq(schema.memberships.orgId, orgId))
        .orderBy(asc(schema.memberships.createdAt));
    },

    /** Invitations to this org that nobody has answered yet. */
    pendingInvitations() {
      return db
        .select({
          id: schema.invitations.id,
          email: schema.invitations.email,
          role: schema.invitations.role,
          expiresAt: schema.invitations.expiresAt,
        })
        .from(schema.invitations)
        .where(
          and(
            eq(schema.invitations.orgId, orgId),
            eq(schema.invitations.status, 'pending'),
            gt(schema.invitations.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(schema.invitations.createdAt));
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

    // ─── Documents ───────────────────────────────────────────────────────────

    /**
     * A page of this org's documents, newest first.
     *
     * Keyset pagination on `(created_at, id)` rather than `OFFSET`: a library
     * is being appended to while it is being read, and an offset silently skips
     * or repeats rows when that happens. `documents_org_created_idx` covers it.
     */
    listDocuments(options: {
      limit: number;
      before?: { createdAt: Date; id: string };
      folderId?: string | null;
    }) {
      const filters = [eq(schema.documents.orgId, orgId)];

      if (options.folderId === null) filters.push(isNull(schema.documents.folderId));
      else if (options.folderId) filters.push(eq(schema.documents.folderId, options.folderId));

      if (options.before) {
        filters.push(
          or(
            lt(schema.documents.createdAt, options.before.createdAt),
            and(
              eq(schema.documents.createdAt, options.before.createdAt),
              lt(schema.documents.id, options.before.id),
            ),
          ) as SQL,
        );
      }

      return db
        .select()
        .from(schema.documents)
        .where(and(...filters))
        .orderBy(desc(schema.documents.createdAt), desc(schema.documents.id))
        .limit(options.limit);
    },

    /**
     * One document, or `undefined` when this org does not have it.
     *
     * The org predicate is what makes "an org cannot read another org's
     * document by guessing its id" true: a foreign id is indistinguishable from
     * a nonexistent one, so the route returns the same 404 for both and no
     * caller learns which.
     */
    async documentById(documentId: string) {
      const [row] = await db
        .select()
        .from(schema.documents)
        .where(and(eq(schema.documents.id, documentId), eq(schema.documents.orgId, orgId)))
        .limit(1);
      return row;
    },

    /**
     * This org's document for a given pair of hashes — the first half of the
     * docId cache lookup.
     *
     * Matching on the document rather than only on `parse_results` also
     * de-duplicates an upload that is still in flight: two people uploading the
     * same file a second apart get one document and one job, not two.
     */
    async documentByHashes(contentHash: string, settingsHash: string) {
      const [row] = await db
        .select()
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.orgId, orgId),
            eq(schema.documents.contentHash, contentHash),
            eq(schema.documents.settingsHash, settingsHash),
          ),
        )
        .limit(1);
      return row;
    },

    /** One folder, or `undefined` when this org does not have it. */
    async folderById(folderId: string) {
      const [row] = await db
        .select()
        .from(schema.folders)
        .where(and(eq(schema.folders.id, folderId), eq(schema.folders.orgId, orgId)))
        .limit(1);
      return row;
    },

    /** Record an uploaded document. The caller has already hashed the bytes. */
    async createDocument(input: {
      id?: string;
      folderId?: string | null;
      filename: string;
      mime: string;
      byteSize: number;
      pageCount?: number | null;
      storageKey: string;
      contentHash: string;
      settingsHash: string;
      sourceUrl?: string | null;
      status?: string;
    }) {
      const [row] = await db
        .insert(schema.documents)
        .values({
          ...(input.id ? { id: input.id } : {}),
          orgId,
          folderId: input.folderId ?? null,
          filename: input.filename,
          mime: input.mime,
          byteSize: input.byteSize,
          pageCount: input.pageCount ?? null,
          storageKey: input.storageKey,
          contentHash: input.contentHash,
          settingsHash: input.settingsHash,
          sourceUrl: input.sourceUrl ?? null,
          status: input.status ?? 'queued',
        })
        .returning();
      return row;
    },

    /**
     * Delete a document and everything hanging off it.
     *
     * Pages, chunks, parse results, conversations and jobs are all `ON DELETE
     * CASCADE` from this row, so one statement inside one transaction removes
     * the lot — which is what "rows and chunks in one transaction" requires.
     * Storage objects are swept *after* the commit by the caller: a blob
     * orphaned by a failed commit is reclaimable, a row pointing at bytes that
     * are already gone is not.
     */
    async deleteDocument(documentId: string) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .delete(schema.documents)
          .where(and(eq(schema.documents.id, documentId), eq(schema.documents.orgId, orgId)))
          .returning();
        return row;
      });
    },

    /** Append to the org's credit ledger. A cache hit writes a zero delta. */
    async recordCredit(input: {
      delta: number;
      reason: string;
      refId?: string | null;
      metadata?: Record<string, unknown>;
    }) {
      const [row] = await db
        .insert(schema.creditLedger)
        .values({
          orgId,
          delta: input.delta,
          reason: input.reason,
          refId: input.refId ?? null,
          metadata: input.metadata ?? null,
        })
        .returning();
      return row;
    },

    /**
     * Record a job for a document.
     *
     * The row is the durable, queryable half of a job; the Redis queue is the
     * half that wakes a worker up. Phase 06 owns the payload's schema — what is
     * written here is deliberately the minimum an operator needs to see that a
     * document is waiting on something.
     */
    async createJob(input: {
      documentId: string;
      type: string;
      payload?: Record<string, unknown>;
    }) {
      const [row] = await db
        .insert(schema.jobs)
        .values({
          orgId,
          documentId: input.documentId,
          type: input.type,
          status: 'pending',
          stage: 'queued',
          payload: input.payload ?? null,
        })
        .returning();
      return row;
    },
  };
}

export type ScopedDb = ReturnType<typeof scopedDb>;
