import { and, arrayContains, asc, desc, eq, gt, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
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

    /** Query document embeddings belonging to this org. */
    documentEmbeddings() {
      return db
        .select()
        .from(schema.documentEmbeddings)
        .where(eq(schema.documentEmbeddings.orgId, orgId));
    },

    /**
     * How many chunks a document has, and how many of them carry a vector.
     *
     * Two numbers rather than one because they answer different questions.
     * `total` is how much of the document is retrievable by keyword, which is
     * true the moment the chunker has written a row. `embedded` is how much of
     * it is retrievable by meaning — and on a stack with no embedding model
     * configured it is legitimately zero forever, which is a state the library
     * has to be able to render rather than a failure.
     */
    async chunkCounts(documentId: string) {
      const [row] = await db
        .select({
          total: sql<number>`count(*)::int`,
          embedded: sql<number>`count(${schema.chunks.embedding})::int`,
        })
        .from(schema.chunks)
        .where(and(eq(schema.chunks.orgId, orgId), eq(schema.chunks.documentId, documentId)));
      return { total: row?.total ?? 0, embedded: row?.embedded ?? 0 };
    },

    /** Query conversations belonging to this org. */
    conversations() {
      return db.select().from(schema.conversations).where(eq(schema.conversations.orgId, orgId));
    },

    /** Query jobs belonging to this org. */
    jobs() {
      return db.select().from(schema.jobs).where(eq(schema.jobs.orgId, orgId));
    },

    /**
     * The most recent job for a document, or `undefined` when it has none.
     *
     * This is what the SSE endpoint replays from after a reconnect, so it
     * wants the *latest* attempt rather than the first: a document that failed
     * and was retried has two rows, and the older one describes a state the
     * browser must not be shown.
     */
    async latestJobForDocument(documentId: string) {
      const [row] = await db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.orgId, orgId), eq(schema.jobs.documentId, documentId)))
        .orderBy(desc(schema.jobs.createdAt), desc(schema.jobs.id))
        .limit(1);
      return row;
    },

    /** Every job in this org that ended in a permanent failure, newest first. */
    listFailedJobs(limit: number) {
      return db
        .select({
          id: schema.jobs.id,
          documentId: schema.jobs.documentId,
          type: schema.jobs.type,
          stage: schema.jobs.stage,
          error: schema.jobs.error,
          errorCode: schema.jobs.errorCode,
          attempts: schema.jobs.attempts,
          createdAt: schema.jobs.createdAt,
          updatedAt: schema.jobs.updatedAt,
        })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.orgId, orgId), eq(schema.jobs.status, 'failed')))
        .orderBy(desc(schema.jobs.updatedAt))
        .limit(limit);
    },

    /** Query folders belonging to this org. */
    folders() {
      return db.select().from(schema.folders).where(eq(schema.folders.orgId, orgId));
    },

    /** The organization this scope is bound to. */
    async organization() {
      const [row] = await db
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
      return row;
    },

    /** Update organization settings JSONB. */
    async updateOrganizationSettings(settings: Record<string, unknown>) {
      const [row] = await db
        .update(schema.organizations)
        .set({ settings })
        .where(eq(schema.organizations.id, orgId))
        .returning();
      return row;
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

    /**
     * Every page of one of this org's documents, in page order.
     *
     * The viewer needs `width`/`height` before it can turn a citation's bbox
     * into a rectangle — the bbox is in PDF points on the *visible* page, so
     * the scale factor is `renderedWidthPx / width` and nothing else — and it
     * needs `thumbnailKey` to know which pages have a rail image at all.
     *
     * Scoped through the document rather than directly, because `pages` has no
     * `org_id` of its own: the join is the tenancy predicate.
     */
    async listPages(documentId: string) {
      return db
        .select({
          pageNo: schema.pages.pageNo,
          width: schema.pages.width,
          height: schema.pages.height,
          thumbnailKey: schema.pages.thumbnailKey,
        })
        .from(schema.pages)
        .innerJoin(schema.documents, eq(schema.pages.documentId, schema.documents.id))
        .where(and(eq(schema.pages.documentId, documentId), eq(schema.documents.orgId, orgId)))
        .orderBy(asc(schema.pages.pageNo));
    },

    /**
     * A single page by document id and page number.
     */
    async pageByNumber(documentId: string, pageNo: number) {
      const [row] = await db
        .select({
          pageNo: schema.pages.pageNo,
          width: schema.pages.width,
          height: schema.pages.height,
          thumbnailKey: schema.pages.thumbnailKey,
        })
        .from(schema.pages)
        .innerJoin(schema.documents, eq(schema.pages.documentId, schema.documents.id))
        .where(
          and(
            eq(schema.pages.documentId, documentId),
            eq(schema.documents.orgId, orgId),
            eq(schema.pages.pageNo, pageNo),
          ),
        )
        .limit(1);
      return row;
    },

    /**
     * Change a document's display name.
     *
     * Returns `undefined` when this org does not have the document, so the
     * caller renders the same 404 it renders for an id that never existed.
     */
    async renameDocument(documentId: string, filename: string) {
      const [row] = await db
        .update(schema.documents)
        .set({ filename, updatedAt: new Date() })
        .where(and(eq(schema.documents.id, documentId), eq(schema.documents.orgId, orgId)))
        .returning();
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

    // ─── Conversations & Messages ──────────────────────────────────────────

    /**
     * Create a conversation belonging to this org.
     */
    async createConversation(input: {
      id?: string;
      userId: string;
      scope?: string;
      documentIds?: string[];
      title?: string | null;
    }) {
      const [row] = await db
        .insert(schema.conversations)
        .values({
          ...(input.id ? { id: input.id } : {}),
          orgId,
          userId: input.userId,
          scope: input.scope ?? 'document',
          documentIds: input.documentIds ?? [],
          title: input.title ?? null,
        })
        .returning();
      if (!row) throw new Error('Failed to create conversation');
      return row;
    },

    /**
     * Get a conversation by ID, or undefined if not found in this org.
     */
    async conversationById(conversationId: string) {
      const [row] = await db
        .select()
        .from(schema.conversations)
        .where(
          and(eq(schema.conversations.id, conversationId), eq(schema.conversations.orgId, orgId)),
        )
        .limit(1);
      return row;
    },

    /**
     * List conversations in this org, newest first, with optional documentId filter
     * and keyset pagination.
     */
    listConversations(options: {
      limit: number;
      before?: { updatedAt: Date; id: string };
      documentId?: string | null;
    }) {
      const filters = [eq(schema.conversations.orgId, orgId)];

      if (options.documentId) {
        filters.push(arrayContains(schema.conversations.documentIds, [options.documentId]));
      }

      if (options.before) {
        filters.push(
          or(
            lt(schema.conversations.updatedAt, options.before.updatedAt),
            and(
              eq(schema.conversations.updatedAt, options.before.updatedAt),
              lt(schema.conversations.id, options.before.id),
            ),
          ) as SQL,
        );
      }

      return db
        .select()
        .from(schema.conversations)
        .where(and(...filters))
        .orderBy(desc(schema.conversations.updatedAt), desc(schema.conversations.id))
        .limit(options.limit);
    },

    /**
     * Delete a conversation belonging to this org.
     * Messages cascade delete via database foreign key.
     */
    async deleteConversation(conversationId: string) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .delete(schema.conversations)
          .where(
            and(eq(schema.conversations.id, conversationId), eq(schema.conversations.orgId, orgId)),
          )
          .returning();
        return row;
      });
    },

    /**
     * Update a conversation's title.
     */
    async updateConversationTitle(conversationId: string, title: string) {
      const [row] = await db
        .update(schema.conversations)
        .set({ title, updatedAt: new Date() })
        .where(
          and(eq(schema.conversations.id, conversationId), eq(schema.conversations.orgId, orgId)),
        )
        .returning();
      if (!row) throw new Error('Failed to update conversation title');
      return row;
    },

    /**
     * Bump a conversation's updatedAt timestamp.
     */
    async touchConversation(conversationId: string) {
      const [row] = await db
        .update(schema.conversations)
        .set({ updatedAt: new Date() })
        .where(
          and(eq(schema.conversations.id, conversationId), eq(schema.conversations.orgId, orgId)),
        )
        .returning();
      return row;
    },

    /**
     * Record a message in a conversation. Enforces that the conversation
     * belongs to this organization.
     */
    async createMessage(input: {
      id?: string;
      conversationId: string;
      role: string;
      content: string;
      citations?: Record<string, unknown>[] | null;
      usage?: Record<string, unknown> | null;
    }) {
      const conv = await db
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.id, input.conversationId),
            eq(schema.conversations.orgId, orgId),
          ),
        )
        .limit(1);

      if (!conv.length) {
        throw new Error('Conversation not found in this organization');
      }

      const [msg] = await db
        .insert(schema.messages)
        .values({
          ...(input.id ? { id: input.id } : {}),
          conversationId: input.conversationId,
          role: input.role,
          content: input.content,
          citations: input.citations ?? null,
          usage: input.usage ?? null,
        })
        .returning();

      if (!msg) throw new Error('Failed to create message');

      // Bump conversation updatedAt

      await db
        .update(schema.conversations)
        .set({ updatedAt: new Date() })
        .where(eq(schema.conversations.id, input.conversationId));

      return msg;
    },

    /**
     * Retrieve messages for a conversation, ordered chronologically.
     * Enforces that the conversation belongs to this organization.
     */
    async messagesForConversation(conversationId: string, options?: { limit?: number }) {
      const conv = await db
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(
          and(eq(schema.conversations.id, conversationId), eq(schema.conversations.orgId, orgId)),
        )
        .limit(1);

      if (!conv.length) {
        return [];
      }

      const query = db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, conversationId))
        .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id));

      if (options?.limit) {
        return query.limit(options.limit);
      }
      return query;
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
