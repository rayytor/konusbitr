import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/client.js';
import { ID_PREFIXES, newId } from '../../src/id.js';
import { migrate } from '../../src/migrate.js';
import { globalParseResultByHashes } from '../../src/queries/documents.js';
import * as schema from '../../src/schema/index.js';
import { scopedDb } from '../../src/scoped.js';

/**
 * Phase 03 integration tests — run against a real Postgres with pgvector.
 *
 * Uses Testcontainers to spin up a disposable Postgres instance with the
 * pgvector extension, then migrates from scratch and exercises every table,
 * the docId cache constraint, and the HNSW/GIN indexes.
 */

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;
let connectionUri: string;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');

  // Use the pgvector image so CREATE EXTENSION vector works
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17')
    .withCommand(['postgres', '-c', 'shared_preload_libraries=', '-c', 'max_connections=50'])
    .start();

  connectionUri = container.getConnectionUri();
  db = createDb(connectionUri);

  // Enable extensions (normally done by docker-entrypoint-initdb.d)
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS unaccent`);

  // Run migrations
  await migrate(connectionUri);
}, 120_000);

afterAll(async () => {
  await container?.stop();
}, 30_000);

// ─── Helper data ─────────────────────────────────────────────────────────────

const userId = newId(ID_PREFIXES.user);
const orgId = newId(ID_PREFIXES.organization);
const folderId = newId(ID_PREFIXES.folder);
const docId = newId(ID_PREFIXES.document);

// ─── Migration idempotency ───────────────────────────────────────────────────

describe('migrations', () => {
  it('running migrate a second time is a no-op', async () => {
    // Should not throw
    await migrate(connectionUri);
  });
});

// ─── Table CRUD ──────────────────────────────────────────────────────────────

describe('table inserts and reads', () => {
  it('inserts a user', async () => {
    await db.insert(schema.users).values({
      id: userId,
      email: 'test@konusbitr.dev',
      name: 'Test User',
    });

    const rows = await db.select().from(schema.users);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe('test@konusbitr.dev');
  });

  it('inserts an organization', async () => {
    await db.insert(schema.organizations).values({
      id: orgId,
      name: 'Test Org',
      slug: 'test-org',
    });

    const rows = await db.select().from(schema.organizations);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe('test-org');
  });

  it('inserts a membership', async () => {
    await db.insert(schema.memberships).values({
      userId,
      orgId,
      role: 'owner',
    });

    const rows = await db.select().from(schema.memberships);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('owner');
  });

  it('inserts an API key', async () => {
    await db.insert(schema.apiKeys).values({
      orgId,
      name: 'Test Key',
      hashedKey: 'sha256:abc123',
      prefix: 'kb_test',
      scopes: ['read', 'write'],
    });

    const rows = await db.select().from(schema.apiKeys);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scopes).toEqual(['read', 'write']);
  });

  it('inserts a folder', async () => {
    await db.insert(schema.folders).values({
      id: folderId,
      orgId,
      name: 'Test Folder',
    });

    const rows = await db.select().from(schema.folders);
    expect(rows).toHaveLength(1);
  });

  it('inserts a document', async () => {
    await db.insert(schema.documents).values({
      id: docId,
      orgId,
      folderId,
      filename: 'test.pdf',
      mime: 'application/pdf',
      byteSize: 12345,
      storageKey: 'uploads/test.pdf',
      contentHash: 'sha256:deadbeef',
      settingsHash: 'sha256:settings1',
      status: 'queued',
    });

    const rows = await db.select().from(schema.documents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('queued');
  });

  it('inserts parse results', async () => {
    await db.insert(schema.parseResults).values({
      documentId: docId,
      contentHash: 'sha256:deadbeef',
      settingsHash: 'sha256:settings1',
      quality: 'standard',
      langList: ['en'],
      markdown: '# Hello',
      pageCount: 1,
    });

    const rows = await db.select().from(schema.parseResults);
    expect(rows).toHaveLength(1);
  });

  it('inserts pages', async () => {
    await db.insert(schema.pages).values({
      documentId: docId,
      pageNo: 1,
      width: 612,
      height: 792,
    });

    const rows = await db.select().from(schema.pages);
    expect(rows).toHaveLength(1);
  });

  it('inserts a conversation and message', async () => {
    const convId = newId(ID_PREFIXES.conversation);

    await db.insert(schema.conversations).values({
      id: convId,
      orgId,
      userId,
      scope: 'document',
      documentIds: [docId],
      title: 'Test conversation',
    });

    await db.insert(schema.messages).values({
      conversationId: convId,
      role: 'user',
      content: 'What is this document about?',
    });

    const msgs = await db.select().from(schema.messages);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe('user');
  });

  it('inserts an extraction', async () => {
    await db.insert(schema.extractions).values({
      orgId,
      documentId: docId,
      schema: { type: 'object' },
      result: { title: 'Test' },
    });

    const rows = await db.select().from(schema.extractions);
    expect(rows).toHaveLength(1);
  });

  it('inserts a job', async () => {
    await db.insert(schema.jobs).values({
      orgId,
      documentId: docId,
      type: 'parse',
      status: 'pending',
    });

    const rows = await db.select().from(schema.jobs);
    expect(rows).toHaveLength(1);
  });

  it('inserts a credit ledger entry', async () => {
    await db.insert(schema.creditLedger).values({
      orgId,
      delta: -10,
      reason: 'parse',
      refId: docId,
    });

    const rows = await db.select().from(schema.creditLedger);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delta).toBe(-10);
  });
});

// ─── docId cache constraint ─────────────────────────────────────────────────

describe('docId cache (unique constraint)', () => {
  it('refuses a second document with the same bytes and settings in one org', async () => {
    await expect(
      db.insert(schema.documents).values({
        orgId,
        filename: 'same-again.pdf',
        mime: 'application/pdf',
        byteSize: 12345,
        storageKey: 'uploads/same-again.pdf',
        contentHash: 'sha256:deadbeef',
        settingsHash: 'sha256:settings1',
        status: 'queued',
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({
          code: '23505',
          message: expect.stringMatching(/unique|duplicate/i),
        }),
      }),
    );
  });

  it('allows the same bytes again under different settings', async () => {
    const [row] = await db
      .insert(schema.documents)
      .values({
        orgId,
        filename: 'same-bytes-advanced.pdf',
        mime: 'application/pdf',
        byteSize: 12345,
        storageKey: 'uploads/same-bytes-advanced.pdf',
        contentHash: 'sha256:deadbeef',
        settingsHash: 'sha256:settings2',
        status: 'queued',
      })
      .returning();

    // A different docId for the same bytes is the point: changing `quality`
    // must produce a new document and its own job, not reuse the old one.
    expect(row?.id).toBeDefined();
    expect(row?.id).not.toBe(docId);
  });

  it('rejects duplicate (content_hash, settings_hash)', async () => {
    await expect(
      db.insert(schema.parseResults).values({
        documentId: docId,
        contentHash: 'sha256:deadbeef',
        settingsHash: 'sha256:settings1',
        quality: 'standard',
        markdown: 'duplicate',
        pageCount: 1,
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({
          code: '23505',
          message: expect.stringMatching(/unique|duplicate/i),
        }),
      }),
    );
  });

  it('allows same content_hash with different settings_hash', async () => {
    await db.insert(schema.parseResults).values({
      documentId: docId,
      contentHash: 'sha256:deadbeef',
      settingsHash: 'sha256:settings2',
      quality: 'advanced',
      markdown: 'different settings',
      pageCount: 1,
    });

    const rows = await db.select().from(schema.parseResults);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── parse_results provenance & cross-tenant cascade ─────────────────────────

describe('parse results provenance and cross-tenant cascade', () => {
  it('sets document_id to NULL on document delete rather than cascading parse_results', async () => {
    const orgA = newId(ID_PREFIXES.organization);
    const orgB = newId(ID_PREFIXES.organization);
    await db.insert(schema.organizations).values([
      { id: orgA, name: 'Org A', slug: `org-a-${Date.now()}` },
      { id: orgB, name: 'Org B', slug: `org-b-${Date.now()}` },
    ]);

    const contentHash = 'sha256:shared-content-bytes';
    const settingsHash = 'sha256:shared-settings';

    const [docA] = await db
      .insert(schema.documents)
      .values({
        orgId: orgA,
        filename: 'doc-a.pdf',
        mime: 'application/pdf',
        byteSize: 54321,
        storageKey: 'uploads/doc-a.pdf',
        contentHash,
        settingsHash,
        status: 'ready',
      })
      .returning();

    const [docB] = await db
      .insert(schema.documents)
      .values({
        orgId: orgB,
        filename: 'doc-b.pdf',
        mime: 'application/pdf',
        byteSize: 54321,
        storageKey: 'uploads/doc-b.pdf',
        contentHash,
        settingsHash,
        status: 'ready',
      })
      .returning();

    // Insert parse result tied to doc A (provenance)
    if (!docA || !docB) {
      throw new Error('Failed to insert test documents');
    }
    const docAId = docA.id;
    const docBId = docB.id;

    const [parseRow] = await db
      .insert(schema.parseResults)
      .values({
        documentId: docAId,
        contentHash,
        settingsHash,
        quality: 'standard',
        markdown: '# Shared Parse Content',
        pageCount: 5,
      })
      .returning();

    if (!parseRow) {
      throw new Error('Failed to insert test parse result');
    }
    const parseRowId = parseRow.id;
    expect(parseRow.documentId).toBe(docAId);

    // Both tenants can read the parse result via global lookup
    const foundBefore = await globalParseResultByHashes(db, contentHash, settingsHash);
    expect(foundBefore).toBeDefined();
    expect(foundBefore?.documentId).toBe(docAId);
    expect(foundBefore?.pageCount).toBe(5);

    // Delete Org A's document
    await db.delete(schema.documents).where(eq(schema.documents.id, docAId));

    // doc A is deleted
    const checkDocA = await db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.id, docAId));
    expect(checkDocA).toHaveLength(0);

    // parse_results row MUST NOT be deleted (ON DELETE SET NULL)
    const remainingParses = await db
      .select()
      .from(schema.parseResults)
      .where(eq(schema.parseResults.id, parseRowId));
    expect(remainingParses).toHaveLength(1);
    expect(remainingParses[0]?.documentId).toBeNull();
    expect(remainingParses[0]?.contentHash).toBe(contentHash);

    // Global lookup still succeeds and backs doc B
    const foundAfter = await globalParseResultByHashes(db, contentHash, settingsHash);
    expect(foundAfter).toBeDefined();
    expect(foundAfter?.id).toBe(parseRowId);
    expect(foundAfter?.documentId).toBeNull();
    expect(foundAfter?.pageCount).toBe(5);

    // doc B remains intact in org B
    const checkDocB = await db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.id, docBId));
    expect(checkDocB).toHaveLength(1);
    expect(checkDocB[0]?.status).toBe('ready');
  });

  it('allows inserting parse_results with null document_id directly', async () => {
    const contentHash = 'sha256:direct-null-content';
    const settingsHash = 'sha256:direct-null-settings';

    const [row] = await db
      .insert(schema.parseResults)
      .values({
        documentId: null,
        contentHash,
        settingsHash,
        quality: 'standard',
        markdown: '# Direct Null Document Parse',
        pageCount: 2,
      })
      .returning();

    if (!row) {
      throw new Error('Failed to insert test parse result');
    }
    expect(row.documentId).toBeNull();

    const lookup = await globalParseResultByHashes(db, contentHash, settingsHash);
    expect(lookup?.documentId).toBeNull();
    expect(lookup?.pageCount).toBe(2);
  });
});

// ─── Vector search (HNSW) ───────────────────────────────────────────────────

describe('HNSW vector index', () => {
  const chunkIds: string[] = [];

  it('inserts chunks with synthetic embeddings', async () => {
    // Create 3 vectors: one at origin-ish, one near it, one far away
    const makeVec = (val: number): number[] => {
      const v = new Array(1024).fill(0);
      v[0] = val;
      v[1] = val;
      return v;
    };

    const values = [
      {
        id: newId(ID_PREFIXES.chunk),
        documentId: docId,
        orgId,
        text: 'chunk near',
        tokenCount: 2,
        embedding: makeVec(0.1),
      },
      {
        id: newId(ID_PREFIXES.chunk),
        documentId: docId,
        orgId,
        text: 'chunk medium',
        tokenCount: 2,
        embedding: makeVec(0.5),
      },
      {
        id: newId(ID_PREFIXES.chunk),
        documentId: docId,
        orgId,
        text: 'chunk far',
        tokenCount: 2,
        embedding: makeVec(0.9),
      },
    ];

    for (const v of values) {
      chunkIds.push(v.id);
    }

    for (const v of values) {
      await db.insert(schema.chunks).values(v);
    }
  });

  it('nearest-neighbour query returns expected ordering', async () => {
    // Query vector near [0.1, 0.1, 0, ...] — should return 'chunk near' first
    const queryVec = new Array(1024).fill(0);
    queryVec[0] = 0.1;
    queryVec[1] = 0.1;
    const vecStr = `[${queryVec.join(',')}]`;

    const results = await db.execute(
      sql`SELECT id, text, embedding <=> ${vecStr}::vector AS distance
          FROM chunks
          WHERE org_id = ${orgId}
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT 3`,
    );

    expect(results.length).toBe(3);
    expect(results[0]?.text).toBe('chunk near');
    expect(results[2]?.text).toBe('chunk far');
  });

  it('EXPLAIN shows HNSW index usage', async () => {
    const queryVec = new Array(1024).fill(0);
    queryVec[0] = 0.1;
    const vecStr = `[${queryVec.join(',')}]`;

    // Disable seq scan to force the planner to use the HNSW index on small data sets
    await db.execute(sql`SET enable_seqscan = off`);

    const plan = await db.execute(
      sql`EXPLAIN SELECT id FROM chunks ORDER BY embedding <=> ${vecStr}::vector LIMIT 5`,
    );

    await db.execute(sql`SET enable_seqscan = on`);

    const planText = plan.map((row) => Object.values(row).join(' ')).join('\n');

    expect(planText.toLowerCase()).toMatch(/hnsw|index scan/i);
  });
});

// ─── Full-text search (GIN) ────────────────────────────────────────────────

describe('GIN tsvector index', () => {
  it('full-text search returns matching chunks', async () => {
    const results = await db.execute(
      sql`SELECT id, text FROM chunks
          WHERE tsv @@ plainto_tsquery('simple', 'chunk')
          AND org_id = ${orgId}`,
    );

    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it('EXPLAIN shows GIN index usage', async () => {
    // With few rows the planner prefers a seq scan; disable it to prove the
    // GIN index exists and is usable.
    await db.execute(sql`SET enable_seqscan = off`);

    const plan = await db.execute(
      sql`EXPLAIN SELECT id FROM chunks WHERE tsv @@ plainto_tsquery('simple', 'chunk')`,
    );

    await db.execute(sql`SET enable_seqscan = on`);

    const planText = plan.map((row) => Object.values(row).join(' ')).join('\n');

    expect(planText.toLowerCase()).toMatch(/gin|bitmap/i);
  });
});

// ─── scopedDb helper ────────────────────────────────────────────────────────

describe('scopedDb', () => {
  it('throws on empty orgId', () => {
    expect(() => scopedDb(db, '')).toThrow('non-empty orgId');
  });

  it('scoped queries return only data for the given org', async () => {
    const scoped = scopedDb(db, orgId);
    const docs = await scoped.documents();
    expect(docs.length).toBeGreaterThanOrEqual(1);
    for (const doc of docs) {
      expect(doc.orgId).toBe(orgId);
    }
  });

  it('scoped queries return nothing for a non-existent org', async () => {
    const scoped = scopedDb(db, 'org_nonexistent');
    const docs = await scoped.documents();
    expect(docs).toHaveLength(0);
  });
});

// ─── newId helper ───────────────────────────────────────────────────────────

describe('newId', () => {
  it('generates prefixed IDs', () => {
    const id = newId('doc');
    expect(id).toMatch(/^doc_/);
    expect(id.length).toBeGreaterThan(5);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId('test')));
    expect(ids.size).toBe(100);
  });
});
