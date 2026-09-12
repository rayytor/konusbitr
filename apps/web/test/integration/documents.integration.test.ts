import { deflateSync } from 'node:zlib';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { createDb, type Database, migrate, scopedDb } from '@konusbitr/db';
import {
  chunksForDocument,
  createOrganization,
  creditEntriesOf,
  ensureExtensions,
  jobsForDocument,
  parseResultsForDocument,
  recordParseResult,
  seedChunk,
} from '@konusbitr/db/testing';
import type { DocumentView } from '@konusbitr/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Phase 05's acceptance criteria, against a real Postgres, Redis and MinIO.
 *
 * The route handlers are imported and called directly rather than through a
 * running Next.js server: what is being tested is the intake path — presign,
 * upload, hash, cache, enqueue — and a server in front of it would add only
 * latency and a second thing that can break. Everything below the handlers is
 * real, including the presigned PUTs, which are done with a plain `fetch` and
 * no credentials, exactly as a browser does them.
 */

const APP_URL = 'http://localhost:3000';
const BUCKET = 'konusbitr-test';
const MINIO_ROOT = 'konusbitr-root';
const MINIO_SECRET = 'konusbitr-root-secret';

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let minio: StartedTestContainer;
let db: Database;
let redis: Redis;

/** The route handlers, imported after the environment is pointed at containers. */
type Handler = (request: Request, context: { params: Promise<unknown> }) => Promise<Response>;
let presign: Handler;
let completeUpload: Handler;
let documents: { GET: Handler; POST: Handler };
let document: { GET: Handler; DELETE: Handler };
let fromUrl: Handler;
let reindex: Handler;

/** An organization and a key that authenticates as it. */
type Tenant = { orgId: string; token: string };
let alpha: Tenant;
let beta: Tenant;

beforeAll(async () => {
  const [{ PostgreSqlContainer }, { RedisContainer }, { GenericContainer, Wait }] =
    await Promise.all([
      import('@testcontainers/postgresql'),
      import('@testcontainers/redis'),
      import('testcontainers'),
    ]);

  [postgres, redisContainer, minio] = await Promise.all([
    new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
    new RedisContainer('redis:7-alpine').start(),
    new GenericContainer('quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z')
      .withCommand(['server', '/data'])
      .withEnvironment({ MINIO_ROOT_USER: MINIO_ROOT, MINIO_ROOT_PASSWORD: MINIO_SECRET })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
      .start(),
  ]);

  const databaseUrl = postgres.getConnectionUri();
  db = createDb(databaseUrl);
  await ensureExtensions(db);
  await migrate(databaseUrl);

  redis = new Redis(redisContainer.getConnectionUrl(), { maxRetriesPerRequest: null });

  const endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;

  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_URL,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisContainer.getConnectionUrl(),
    S3_ENDPOINT: endpoint,
    S3_REGION: 'us-east-1',
    S3_BUCKET: BUCKET,
    S3_ACCESS_KEY_ID: MINIO_ROOT,
    S3_SECRET_ACCESS_KEY: MINIO_SECRET,
    S3_FORCE_PATH_STYLE: 'true',
    AUTH_SECRET: 'konusbitr-development-secret-change-me',
    MAX_UPLOAD_BYTES: String(64 * 1024 * 1024),
    MAX_PAGES: '0',
    ALLOW_GLOBAL_PARSE_CACHE: 'false',
  });

  // Imported only now: the modules read the environment as they load, which is
  // the same "fail loudly at boot" behaviour the server has.
  const { storage } = await import('@/lib/storage');
  await storage().client.send(new CreateBucketCommand({ Bucket: BUCKET }));

  presign = (await import('@/app/api/uploads/presign/route')).POST as Handler;
  completeUpload = (await import('@/app/api/uploads/complete/route')).POST as Handler;
  documents = (await import('@/app/api/documents/route')) as unknown as {
    GET: Handler;
    POST: Handler;
  };
  document = (await import('@/app/api/documents/[documentId]/route')) as unknown as {
    GET: Handler;
    DELETE: Handler;
  };
  fromUrl = (await import('@/app/api/documents/from-url/route')).POST as Handler;
  reindex = (await import('@/app/api/documents/[documentId]/reindex/route')).POST as Handler;

  alpha = await tenant('Alpha', 'alpha');
  beta = await tenant('Beta', 'beta');
}, 300_000);

afterAll(async () => {
  redis?.disconnect();
  await Promise.all([postgres?.stop(), redisContainer?.stop(), minio?.stop()]);
}, 90_000);

// ─── Fixtures and helpers ────────────────────────────────────────────────────

async function tenant(name: string, slug: string): Promise<Tenant> {
  const { generateApiKey } = await import('@/lib/auth/api-key');
  const organization = await createOrganization(db, name, slug);
  const generated = generateApiKey();

  await scopedDb(db, organization.id).createApiKey({
    name: `${name} key`,
    hashedKey: generated.hashedKey,
    prefix: generated.prefix,
    scopes: ['documents:read', 'documents:write'],
  });

  return { orgId: organization.id, token: generated.token };
}

function call(
  handler: Handler,
  options: { method?: string; body?: unknown; as: Tenant; params?: unknown; query?: string } = {
    as: alpha,
  },
): Promise<Response> {
  const url = `${APP_URL}/api/x${options.query ?? ''}`;
  return handler(
    new Request(url, {
      method: options.method ?? 'GET',
      headers: {
        'x-api-key': options.as.token,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    { params: Promise.resolve(options.params ?? {}) },
  );
}

/** A tiny, well-formed PDF whose page count and bytes are both predictable. */
function pdfWith(marker: string, pages = 1): Buffer {
  const body = Array.from(
    { length: pages },
    (_unused, index) => `${index + 2} 0 obj\n<< /Type /Page >>\nendobj\n`,
  ).join('');
  return Buffer.from(`%PDF-1.7\n% ${marker}\n${body}trailer\n<< /Size 9 >>\n%%EOF\n`, 'latin1');
}

/**
 * The whole browser-side flow: presign, PUT directly to storage, register.
 *
 * Nothing here hands the file to a route handler — the bytes go from this
 * function to MinIO over a presigned URL, which is the property the phase is
 * built around.
 */
async function upload(
  file: Buffer,
  options: { as?: Tenant; filename?: string; settings?: Record<string, unknown> } = {},
): Promise<{
  status: number;
  body: { document?: DocumentView; error?: { code: string; message: string } };
}> {
  const as = options.as ?? alpha;
  const filename = options.filename ?? 'report.pdf';

  const ticketResponse = await call(presign, {
    method: 'POST',
    as,
    body: { filename, mimeType: 'application/pdf', byteSize: file.length },
  });

  if (!ticketResponse.ok) {
    return { status: ticketResponse.status, body: await ticketResponse.json() };
  }

  const ticket = (await ticketResponse.json()) as {
    uploadId: string;
    strategy: 'single' | 'multipart';
    url?: string;
    partSize?: number;
    parts?: { partNumber: number; url: string }[];
  };

  if (ticket.strategy === 'multipart') {
    const parts: { partNumber: number; etag: string }[] = [];
    for (const part of ticket.parts ?? []) {
      const start = (part.partNumber - 1) * (ticket.partSize ?? 0);
      const slice = file.subarray(start, start + (ticket.partSize ?? 0));
      const response = await fetch(part.url, { method: 'PUT', body: new Uint8Array(slice) });
      parts.push({ partNumber: part.partNumber, etag: response.headers.get('etag') ?? '' });
    }
    await call(completeUpload, { method: 'POST', as, body: { uploadId: ticket.uploadId, parts } });
  } else {
    await fetch(ticket.url as string, {
      method: 'PUT',
      body: new Uint8Array(file),
      headers: { 'content-type': 'application/pdf' },
    });
  }

  const created = await call(documents.POST, {
    method: 'POST',
    as,
    body: {
      uploadId: ticket.uploadId,
      ...(options.settings ? { settings: options.settings } : {}),
    },
  });

  return { status: created.status, body: await created.json() };
}

async function queuedJobs(): Promise<number> {
  return redis.xlen('konusbitr:jobs');
}

// ─── The docId cache ─────────────────────────────────────────────────────────

describe('uploading a document', () => {
  const file = pdfWith('first upload', 3);
  let first: DocumentView;

  it('stores it, queues a parse job, and reports its pages', async () => {
    const before = await queuedJobs();
    const result = await upload(file);

    expect(result.status).toBe(201);
    first = result.body.document as DocumentView;

    expect(first.status).toBe('queued');
    expect(first.pageCount).toBe(3);
    expect(first.byteSize).toBe(file.length);
    expect(first.cached).toBe(false);

    expect(await jobsForDocument(db, first.id)).toHaveLength(1);
    expect(await queuedJobs()).toBe(before + 1);
  });

  it('put the bytes in storage under a key derived from the document id', async () => {
    const { storage } = await import('@/lib/storage');
    const { originalKey } = await import('@konusbitr/storage');

    const head = await storage().head(originalKey(alpha.orgId, first.id, 'pdf'));
    expect(head?.byteSize).toBe(file.length);
  });

  it('returns the same docId, already ready, when the same file is uploaded again', async () => {
    // Stand in for the worker: Phase 05 ends by enqueuing a job nothing
    // consumes, so the finished parse has to be written here.
    const stored = await scopedDb(db, alpha.orgId).documentById(first.id);
    await recordParseResult(db, {
      documentId: first.id,
      contentHash: stored?.contentHash ?? '',
      settingsHash: stored?.settingsHash ?? '',
      pageCount: 3,
    });

    const before = await queuedJobs();
    const again = await upload(file);

    expect(again.status).toBe(200);
    expect(again.body.document?.id).toBe(first.id);
    expect(again.body.document?.status).toBe('ready');
    expect(again.body.document?.cached).toBe(true);

    // Milliseconds, no credits, and — the point — no second job.
    expect(await jobsForDocument(db, first.id)).toHaveLength(1);
    expect(await queuedJobs()).toBe(before);
  });

  it('records a zero-delta cache_hit in the credit ledger', async () => {
    const entries = await creditEntriesOf(db, alpha.orgId);
    const hit = entries.find((entry) => entry.reason === 'cache_hit');

    expect(hit).toBeDefined();
    expect(hit?.delta).toBe(0);
    expect(hit?.refId).toBe(first.id);
  });

  it('produces a different docId, and a new job, when quality changes', async () => {
    const before = await queuedJobs();
    const advanced = await upload(file, { settings: { quality: 'advanced' } });

    expect(advanced.status).toBe(201);

    const second = advanced.body.document as DocumentView;
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('queued');

    expect(await jobsForDocument(db, second.id)).toHaveLength(1);
    expect(await queuedJobs()).toBe(before + 1);
  });

  it('does not share a cache entry with another organization by default', async () => {
    // ALLOW_GLOBAL_PARSE_CACHE is false, so Beta must not learn that Alpha
    // already holds this file — it gets its own document and its own job.
    const result = await upload(file, { as: beta });

    expect(result.status).toBe(201);
    expect(result.body.document?.id).not.toBe(first.id);
    expect(result.body.document?.status).toBe('queued');
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe('what will not be accepted', () => {
  async function rejected(file: Buffer, filename = 'suspicious.pdf') {
    const result = await upload(file, { filename });
    return result;
  }

  it('refuses a file that is not a PDF, whatever it claims to be', async () => {
    const result = await rejected(Buffer.from('PK a zip in disguise', 'latin1'));

    expect(result.status).toBe(415);
    expect(result.body.error?.code).toBe('unsupported_media_type');
  });

  it('refuses an encrypted PDF and says what to do about it', async () => {
    const encrypted = Buffer.from(
      '%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\ntrailer\n<< /Encrypt 9 0 R >>\n%%EOF\n',
      'latin1',
    );
    const result = await rejected(encrypted);

    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe('encrypted_pdf');
    expect(result.body.error?.message).toMatch(/password protection/i);
  });

  it('refuses a decompression bomb and does not keep it', async () => {
    const compressed = deflateSync(Buffer.alloc(80 * 1024 * 1024));
    const bomb = Buffer.concat([
      Buffer.from('%PDF-1.7\n1 0 obj\n<< /Length 1 /Filter /FlateDecode >>\nstream\n', 'latin1'),
      compressed,
      Buffer.from('\nendstream\nendobj\ntrailer\n<< /Size 2 >>\n%%EOF\n', 'latin1'),
    ]);

    const result = await rejected(bomb, 'bomb.pdf');

    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe('decompression_bomb');
    expect(result.body.error?.message).toMatch(/not been stored/i);
  });

  it('refuses a declared size over the limit before signing anything', async () => {
    const response = await call(presign, {
      method: 'POST',
      as: alpha,
      body: {
        filename: 'huge.pdf',
        mimeType: 'application/pdf',
        byteSize: 1024 * 1024 * 1024,
      },
    });

    expect(response.status).toBe(413);
  });

  it('refuses an upload id it never issued', async () => {
    const response = await call(documents.POST, {
      method: 'POST',
      as: alpha,
      body: { uploadId: 'up_madeitup' },
    });

    expect(response.status).toBe(404);
  });
});

// ─── URL ingest ──────────────────────────────────────────────────────────────

describe('importing from a URL', () => {
  it.each([
    ['the cloud metadata service', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://localhost:9000/konusbitr/anything.pdf'],
    ['a private address', 'http://10.0.0.5/internal.pdf'],
    ['a non-web scheme', 'file:///etc/passwd'],
  ])('refuses %s', async (_label, url) => {
    const response = await call(fromUrl, { method: 'POST', as: alpha, body: { url } });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toMatch(/^url_/);
  });
});

// ─── Tenancy and deletion ────────────────────────────────────────────────────

describe('one organization cannot reach another’s documents', () => {
  let owned: DocumentView;

  it('creates a document belonging to Alpha', async () => {
    const result = await upload(pdfWith('alpha only'));
    owned = result.body.document as DocumentView;
    expect(owned.id).toBeDefined();
  });

  it('returns 404 — not 403 — when Beta guesses the id', async () => {
    // 403 would confirm the id exists. The whole point is that a foreign id and
    // a nonexistent one are indistinguishable.
    const read = await call(document.GET, {
      as: beta,
      params: { documentId: owned.id },
    });
    expect(read.status).toBe(404);

    const deleted = await call(document.DELETE, {
      method: 'DELETE',
      as: beta,
      params: { documentId: owned.id },
    });
    expect(deleted.status).toBe(404);
  });

  it('leaves the document intact after the attempt', async () => {
    const read = await call(document.GET, { as: alpha, params: { documentId: owned.id } });
    expect(read.status).toBe(200);

    const body = (await read.json()) as { document: DocumentView; downloadUrl: string };
    expect(body.document.id).toBe(owned.id);
    expect(body.downloadUrl).toContain('X-Amz-Signature');
  });

  it('lists only the caller’s own documents', async () => {
    const response = await call(documents.GET, { as: beta, query: '?limit=100' });
    const body = (await response.json()) as { documents: DocumentView[] };

    expect(body.documents.some((row) => row.id === owned.id)).toBe(false);
  });
});

describe('deleting a document', () => {
  it('removes its rows, its chunks and its bytes', async () => {
    const result = await upload(pdfWith('to be deleted'));
    const doomed = result.body.document as DocumentView;

    await seedChunk(db, { documentId: doomed.id, orgId: alpha.orgId });
    expect(await chunksForDocument(db, doomed.id)).toHaveLength(1);

    const { storage } = await import('@/lib/storage');
    const { documentPrefix, originalKey } = await import('@konusbitr/storage');
    const key = originalKey(alpha.orgId, doomed.id, 'pdf');
    expect(await storage().head(key)).not.toBeNull();

    const response = await call(document.DELETE, {
      method: 'DELETE',
      as: alpha,
      params: { documentId: doomed.id },
    });
    expect(response.status).toBe(204);

    expect(await scopedDb(db, alpha.orgId).documentById(doomed.id)).toBeUndefined();
    expect(await chunksForDocument(db, doomed.id)).toHaveLength(0);
    expect(await jobsForDocument(db, doomed.id)).toHaveLength(0);
    expect(await storage().head(key)).toBeNull();

    // Nothing is left under the document's prefix either — thumbnails and
    // extracted images would be swept by the same call.
    expect(await storage().deletePrefix(documentPrefix(alpha.orgId, doomed.id))).toBe(0);
  });

  it('reports 404 for a document that is already gone', async () => {
    const response = await call(document.DELETE, {
      method: 'DELETE',
      as: alpha,
      params: { documentId: 'doc_clx1neverexisted' },
    });

    expect(response.status).toBe(404);
  });
});

// ─── Reindex ─────────────────────────────────────────────────────────────────

describe('reindexing a document', () => {
  it('queues a reindex job without touching the parse', async () => {
    // The endpoint behind the criterion that switching EMBEDDING_MODEL between
    // a cloud and a local model needs only env changes plus a reindex: the
    // parse artifact is already keyed on the file's bytes and its settings, so
    // the job the worker picks up skips Docling entirely.
    const result = await upload(pdfWith('to be reindexed', 2));
    const uploaded = result.body.document as DocumentView;

    // Stand in for the worker having finished: the parse exists and the
    // document is ready.
    await recordParseResult(db, {
      documentId: uploaded.id,
      contentHash: (await scopedDb(db, alpha.orgId).documentById(uploaded.id))
        ?.contentHash as string,
      settingsHash: (await scopedDb(db, alpha.orgId).documentById(uploaded.id))
        ?.settingsHash as string,
      pageCount: 2,
    });

    const before = await queuedJobs();
    const response = await call(reindex, {
      method: 'POST',
      as: alpha,
      params: { documentId: uploaded.id },
    });

    // 202: accepted, not done. The browser follows it on the same SSE stream
    // an upload uses rather than polling this endpoint.
    expect(response.status).toBe(202);
    const body = (await response.json()) as { jobId: string; documentId: string };
    expect(body.documentId).toBe(uploaded.id);

    expect(await queuedJobs()).toBe(before + 1);
    const jobs = await jobsForDocument(db, uploaded.id);
    expect(jobs.some((job) => job.type === 'reindex')).toBe(true);

    // Still one parse result: a reindex is not a re-parse.
    expect(await parseResultsForDocument(db, uploaded.id)).toHaveLength(1);
  });

  it('refuses a document that has not finished processing', async () => {
    // A document with no artifact has nothing to index, and queueing a job
    // that will fail on a cache miss is worse than saying so now.
    const result = await upload(pdfWith('still queued'));
    const pending = result.body.document as DocumentView;
    expect(pending.status).toBe('queued');

    const response = await call(reindex, {
      method: 'POST',
      as: alpha,
      params: { documentId: pending.id },
    });

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe('not_indexable_yet');
  });

  it('is 404 for another organization, not 403', async () => {
    const result = await upload(pdfWith('alpha only'), { as: alpha });
    const mine = result.body.document as DocumentView;

    const response = await call(reindex, {
      method: 'POST',
      as: beta,
      params: { documentId: mine.id },
    });

    // A 403 would confirm the id exists. An attacker enumerating ids must
    // learn nothing from the difference.
    expect(response.status).toBe(404);
  });
});
