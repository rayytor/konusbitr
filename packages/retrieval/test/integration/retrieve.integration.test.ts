import { createDb, type Database } from '@konusbitr/db';
import { migrate } from '@konusbitr/db/migrate';
import * as schema from '@konusbitr/db/schema';
import { ensureExtensions } from '@konusbitr/db/testing';
import { type Env, parseEnv } from '@konusbitr/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchDense } from '../../src/dense.js';
import { retrieve } from '../../src/retrieve.js';
import { hashingEmbed, hashingEmbedder } from '../../src/testing.js';

/**
 * Phase 09 integration tests — the retrieval pipeline against a real Postgres
 * with pgvector, rather than against a mock that answers every query the same.
 *
 * This file exists because the unit tests could not have caught the bug it was
 * written for. `searchDense` set `hnsw.ef_search` with a bind parameter and
 * outside a transaction, both of which Postgres rejects; the mocked database in
 * the unit tests has no `execute`, so the failure was indistinguishable from
 * the mock, and in production the dense leg simply never ran. Real SQL is the
 * only thing that tells the difference.
 */

let container: StartedPostgreSqlContainer;
let db: Database;
let env: Env;

const orgA = 'org_retrieval_a';
const orgB = 'org_retrieval_b';
const docLease = 'doc_lease_agreement';
const docInvoice = 'doc_invoice_book';
const docVerbose = 'doc_verbose_manual';
const docOther = 'doc_other_org';

/** The passages the assertions below are written against. */
const corpus: {
  id: string;
  org: string;
  doc: string;
  ordinal: number;
  page: number;
  text: string;
}[] = [
  {
    id: 'chk_lease_1',
    org: orgA,
    doc: docLease,
    ordinal: 0,
    page: 1,
    text: 'The tenant shall pay rent on the first day of each calendar month without demand.',
  },
  {
    id: 'chk_lease_2',
    org: orgA,
    doc: docLease,
    ordinal: 1,
    page: 4,
    text: 'The security deposit is returned within thirty days of the end of the tenancy.',
  },
  {
    id: 'chk_invoice_1',
    org: orgA,
    doc: docInvoice,
    ordinal: 0,
    page: 2,
    text: 'Invoice INV-4471-QX was issued to Northwind Freight for warehouse handling.',
  },
  {
    id: 'chk_invoice_2',
    org: orgA,
    doc: docInvoice,
    ordinal: 1,
    page: 7,
    text: 'Payment terms are net thirty days from the invoice date shown in the header.',
  },
  {
    // A figure chunk: a vision model's description of a bar chart, written by
    // the Phase 12.2 parse and indexed like any other passage. The document it
    // belongs to says nothing about regions in its prose, so a query that finds
    // it found it through the chart.
    id: 'chk_lease_figure',
    org: orgA,
    doc: docLease,
    ordinal: 2,
    page: 9,
    text:
      '[Figure: A stacked bar chart of leased floorspace by region. ' +
      'North America accounts for 54 percent, Europe for 28 percent and Asia Pacific for 18 percent.]',
  },
  {
    id: 'chk_other_org',
    org: orgB,
    doc: docOther,
    ordinal: 0,
    page: 1,
    text: 'Invoice INV-4471-QX appears here too, in a different tenant entirely.',
  },
];

// One verbose document that would crowd out the corpus without a diversity cap.
for (let i = 0; i < 8; i++) {
  corpus.push({
    id: `chk_verbose_${i}`,
    org: orgA,
    doc: docVerbose,
    ordinal: i,
    page: i + 1,
    text: `Rent, tenancy, deposit and invoice terms restated for the ${i + 1}th time in a long manual.`,
  });
}

beforeAll(async () => {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17')
    .withCommand(['postgres', '-c', 'shared_preload_libraries=', '-c', 'max_connections=50'])
    .start();

  const uri = container.getConnectionUri();
  db = createDb(uri);
  await ensureExtensions(db);
  await migrate(uri);

  env = parseEnv({
    APP_URL: 'http://localhost:3000',
    DATABASE_URL: uri,
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'konusbitr',
    S3_ACCESS_KEY_ID: 'konusbitr',
    S3_SECRET_ACCESS_KEY: 'konusbitr-dev-secret',
  });

  for (const [org, slug] of [
    [orgA, 'retrieval-a'],
    [orgB, 'retrieval-b'],
  ] as const) {
    await db.insert(schema.organizations).values({ id: org, name: slug, slug });
  }

  for (const [id, org] of [
    [docLease, orgA],
    [docInvoice, orgA],
    [docVerbose, orgA],
    [docOther, orgB],
  ] as const) {
    await db.insert(schema.documents).values({
      id,
      orgId: org,
      filename: `${id}.pdf`,
      mime: 'application/pdf',
      byteSize: 1024,
      storageKey: `orgs/${org}/documents/${id}/original.pdf`,
      contentHash: `hash-${id}`,
      settingsHash: 'settings',
      status: 'ready',
      pageCount: 10,
    });
  }

  await db.insert(schema.chunks).values(
    corpus.map((row) => ({
      id: row.id,
      documentId: row.doc,
      orgId: row.org,
      ordinal: row.ordinal,
      text: row.text,
      tokenCount: row.text.split(/\s+/).length,
      pages: [{ page: row.page, bbox: [72, 100, 540, 160] as [number, number, number, number] }],
      sectionPath: 'Body',
      embedding: hashingEmbed(row.text),
    })),
  );
}, 180_000);

afterAll(async () => {
  await container?.stop();
}, 60_000);

/** A pool pointed at nothing, for the case where every leg fails. */
const unreachableDb = createDb('postgresql://nobody:nobody@127.0.0.1:1/none');

const retrieveIn = (overrides: Parameters<typeof retrieve>[0]) =>
  retrieve({ db, env, embed: hashingEmbedder(), rerankEnabled: false, ...overrides });

describe('the dense leg against real pgvector', () => {
  it('runs the query with hnsw.ef_search applied instead of failing on it', async () => {
    // The regression this file was written for. `SET LOCAL hnsw.ef_search = $1`
    // is a syntax error, and `SET LOCAL` outside a transaction is a no-op that
    // Postgres reports as a warning; either way the dense leg returned nothing.
    const results = await searchDense({
      db,
      orgId: orgA,
      scope: { kind: 'corpus' },
      queryVector: hashingEmbed('rent is due on the first day of the month'),
      efSearch: 64,
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((chunk) => chunk.documentId !== docOther)).toBe(true);
  });

  it('applies ef_search inside a transaction and leaves the session setting alone', async () => {
    await searchDense({
      db,
      orgId: orgA,
      scope: { kind: 'corpus' },
      queryVector: hashingEmbed('deposit'),
      efSearch: 200,
    });

    const rows = (await db.execute(
      sql`SELECT current_setting('hnsw.ef_search', true) AS value`,
    )) as unknown as { value: string | null }[];

    // `SET LOCAL` is scoped to its transaction, so the pooled session must not
    // still be carrying 200 into whatever query runs next.
    expect(rows[0]?.value).not.toBe('200');
  });

  it('ignores an ef_search value it cannot vouch for rather than interpolating it', async () => {
    // The value reaches SQL as text because `SET` takes no bind parameter, so
    // anything that is not a usable integer has to be dropped here rather than
    // become a syntax error at the far end.
    for (const efSearch of [Number.NaN, Number.POSITIVE_INFINITY, -5, 10_000]) {
      const results = await searchDense({
        db,
        orgId: orgA,
        scope: { kind: 'corpus' },
        queryVector: hashingEmbed('rent'),
        efSearch,
      });
      expect(Array.isArray(results)).toBe(true);
    }
  });
});

describe('retrieve() against real SQL', () => {
  it('never returns a chunk belonging to another organization', async () => {
    const results = await retrieveIn({
      orgId: orgA,
      scope: { kind: 'corpus' },
      query: 'INV-4471-QX',
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((chunk) => chunk.id === 'chk_other_org')).toBe(false);
    expect(results.every((chunk) => chunk.documentId !== docOther)).toBe(true);
  });

  it('finds a rare exact token, which is the sparse leg doing real work', async () => {
    // "INV-4471-QX" appears in exactly one chunk in this org. A dense-only
    // pipeline has no reason to rank it first; the FTS leg does.
    const results = await retrieveIn({
      orgId: orgA,
      scope: { kind: 'corpus' },
      query: 'INV-4471-QX',
    });

    expect(results[0]?.id).toBe('chk_invoice_1');
  });

  it('keeps page and bbox geometry intact through fusion and capping', async () => {
    const results = await retrieveIn({
      orgId: orgA,
      scope: { kind: 'document', documentId: docLease },
      query: 'when is the security deposit returned',
    });

    const deposit = results.find((chunk) => chunk.id === 'chk_lease_2');
    expect(deposit).toBeDefined();
    expect(deposit?.page).toBe(4);
    expect(deposit?.bbox).toEqual([72, 100, 540, 160]);
    expect(deposit?.pages).toEqual([{ page: 4, bbox: [72, 100, 540, 160] }]);
  });

  it('retrieves a figure chunk for a question only the chart can answer', async () => {
    // The Phase 12.2 acceptance criterion, and the reason figures are captioned
    // at all: `floorspace by region` appears nowhere in this corpus except in a
    // description of a bar chart. A pipeline that extracted the chart and never
    // described it returns nothing here, and the document looks as though it
    // does not contain the answer.
    const results = await retrieveIn({
      orgId: orgA,
      scope: { kind: 'corpus' },
      query: 'floorspace by region Asia Pacific',
    });

    const figure = results.find((chunk) => chunk.id === 'chk_lease_figure');
    expect(figure).toBeDefined();
    // And it still says where it came from, so the citation lands on the chart.
    expect(figure?.pages[0]).toEqual({ page: 9, bbox: [72, 100, 540, 160] });
  });

  it('confines a document-scoped search to that document', async () => {
    const results = await retrieveIn({
      orgId: orgA,
      scope: { kind: 'document', documentId: docInvoice },
      query: 'rent tenancy deposit invoice terms',
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((chunk) => chunk.documentId === docInvoice)).toBe(true);
  });

  it('returns no more than three chunks from any one document in corpus mode', async () => {
    const results = await retrieveIn({
      orgId: orgA,
      scope: { kind: 'corpus' },
      query: 'rent tenancy deposit invoice terms restated',
      topK: 8,
    });

    const perDocument = new Map<string, number>();
    for (const chunk of results) {
      perDocument.set(chunk.documentId, (perDocument.get(chunk.documentId) ?? 0) + 1);
    }

    expect(results.length).toBeGreaterThan(3);
    for (const count of perDocument.values()) {
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it('still returns sensible results with reranking switched off', async () => {
    const results = await retrieveIn({
      orgId: orgA,
      scope: { kind: 'corpus' },
      query: 'security deposit returned at the end of the tenancy',
      rerankEnabled: false,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((chunk) => chunk.id === 'chk_lease_2')).toBe(true);
  });

  it('keeps working on a corpus whose chunks have no vectors yet', async () => {
    // The default `.env` configures no embedding model, so chunks are written
    // without vectors. That is a supported state, not a half-finished one:
    // retrieval has to fall back to keyword search rather than return nothing.
    const legErrors: string[] = [];
    const results = await retrieve({
      db,
      env,
      orgId: orgA,
      scope: { kind: 'corpus' },
      query: 'INV-4471-QX',
      rerankEnabled: false,
      onLegError: (leg) => legErrors.push(leg),
    });

    expect(legErrors).toEqual([]);
    expect(results.some((chunk) => chunk.id === 'chk_invoice_1')).toBe(true);
  });

  it('reports a failing dense leg instead of quietly becoming keyword-only', async () => {
    // pgvector rejects a vector of the wrong width. Before this phase the
    // rejection was swallowed by a bare `.catch(() => [])` and the caller saw
    // sparse-only results that looked entirely healthy.
    const legErrors: string[] = [];
    const results = await retrieveIn({
      orgId: orgA,
      scope: { kind: 'corpus' },
      query: 'INV-4471-QX',
      embed: async () => [1, 2, 3],
      onLegError: (leg) => legErrors.push(leg),
    });

    expect(legErrors).toContain('dense');
    // Degraded, but not empty: the sparse leg still answered.
    expect(results.some((chunk) => chunk.id === 'chk_invoice_1')).toBe(true);
  });

  it('raises rather than returning nothing when every leg fails', async () => {
    await expect(
      retrieveIn({
        orgId: orgA,
        scope: { kind: 'corpus' },
        query: 'rent',
        // Nothing is listening there, so both legs reject and the caller is
        // told, rather than receiving an empty result set that reads as
        // "no matches".
        db: unreachableDb,
        embed: async () => [1, 2, 3],
      }),
    ).rejects.toThrow(/every leg errored/);
  });
});
