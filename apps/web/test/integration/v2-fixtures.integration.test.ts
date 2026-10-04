import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { createDb, type Database, migrate, scopedDb } from '@konusbitr/db';
import {
  chunksForDocument,
  createOrganization,
  creditEntriesOf,
  ensureExtensions,
} from '@konusbitr/db/testing';
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from '@konusbitr/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Phase 13's acceptance criteria, against real fixtures and the real worker.
 *
 * `v2.integration.test.ts` drives the API over documents it seeds by hand,
 * which is the right way to test an error envelope and the wrong way to find
 * out whether the thing works. A seeded parse has whatever headings the test
 * wrote into it; a seeded split never opens a PDF. This file is the other
 * half: bytes from `fixtures/pdf` go in through multipart, the Python worker
 * that Compose runs reads them, and every assertion is about what came out of
 * a real document.
 *
 * The one fake is the chat model, which is a small HTTP server here so that the
 * suite needs no provider key — and so that the *quotes* it returns can be
 * taken from the parse that just happened, which is what makes "every citation
 * verifies" a statement about the verifier rather than about a model's mood.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const WORKER_DIR = `${REPO_ROOT}/services/worker`;
const FIXTURES = `${REPO_ROOT}/fixtures/pdf`;

const APP_URL = 'http://localhost:3000';
const BUCKET = 'konusbitr-v2-fixtures';
const MINIO_ROOT = 'konusbitr-root';
const MINIO_SECRET = 'konusbitr-root-secret';
const WEBHOOK_SECRET = 'v2-fixtures-webhook-secret';

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let minio: StartedTestContainer;
let db: Database;
let worker: { stop(): Promise<void>; logs(): string };

let models: Server;
let nextCompletion = '';
let hooks: Server;
let hookUrl: string;
let deliveries: { body: string; signature: string | null; timestamp: string | null }[] = [];

type App = { fetch: (request: Request) => Response | Promise<Response> };
let v2: App;
let v1: App;
let orgId: string;
let token: string;

type Element = {
  type: string;
  text?: string;
  page: number;
  bbox: number[];
  level?: number | null;
};
type Parsed = {
  docId: string;
  markdown: string;
  contents: Element[];
  images: unknown[];
  pageCount: number;
  cached: boolean;
};

/** The first parse of the ten-page fixture, which most of the suite builds on. */
let parsed: Parsed;

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
    new GenericContainer('pgsty/minio:RELEASE.2026-08-04T00-00-00Z')
      .withCommand(['server', '/data'])
      .withEnvironment({ MINIO_ROOT_USER: MINIO_ROOT, MINIO_ROOT_PASSWORD: MINIO_SECRET })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
      .start(),
  ]);

  const databaseUrl = postgres.getConnectionUri();
  const redisUrl = redisContainer.getConnectionUrl();
  const s3Endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;

  db = createDb(databaseUrl);
  await ensureExtensions(db);
  await migrate(databaseUrl);

  models = await listen(
    createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'cmpl_test',
            model: 'test-chat',
            choices: [{ index: 0, message: { role: 'assistant', content: nextCompletion } }],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          }),
        );
      });
    }),
  );

  hooks = await listen(
    createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        deliveries.push({
          body,
          signature: (request.headers[WEBHOOK_SIGNATURE_HEADER] as string) ?? null,
          timestamp: (request.headers[WEBHOOK_TIMESTAMP_HEADER] as string) ?? null,
        });
        response.writeHead(200).end('ok');
      });
    }),
  );
  hookUrl = `http://127.0.0.1:${(hooks.address() as AddressInfo).port}/hook`;

  const shared = {
    NODE_ENV: 'test',
    APP_URL,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    S3_ENDPOINT: s3Endpoint,
    S3_REGION: 'us-east-1',
    S3_BUCKET: BUCKET,
    S3_ACCESS_KEY_ID: MINIO_ROOT,
    S3_SECRET_ACCESS_KEY: MINIO_SECRET,
    S3_FORCE_PATH_STYLE: 'true',
  };

  Object.assign(process.env, {
    ...shared,
    AUTH_SECRET: 'konusbitr-development-secret-change-me',
    ALLOW_GLOBAL_PARSE_CACHE: 'false',
    LLM_API_KEY: 'sk-test',
    LLM_BASE_URL: `http://127.0.0.1:${(models.address() as AddressInfo).port}`,
    LLM_CHAT_MODEL: 'test-chat',
    CREDITS_MODE: 'unlimited',
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_PER_KEY_PER_MINUTE: '100000',
    RATE_LIMIT_PER_ORG_PER_MINUTE: '100000',
    WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET,
    WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true',
  });

  const { storage } = await import('@/lib/storage');
  await storage().client.send(new CreateBucketCommand({ Bucket: BUCKET }));

  const app = await import('@/lib/v2/app');
  v2 = app.createV2App() as unknown as App;
  v1 = app.createV1App() as unknown as App;

  const organization = await createOrganization(db, 'Fixtures', 'v2-fixtures');
  orgId = organization.id;

  const { generateApiKey } = await import('@/lib/auth/api-key');
  const generated = generateApiKey();
  await scopedDb(db, orgId).createApiKey({
    name: 'fixtures key',
    hashedKey: generated.hashedKey,
    prefix: generated.prefix,
    scopes: ['parse', 'extract', 'split', 'ask', 'chat', 'documents:read', 'documents:write'],
  });
  token = generated.token;

  worker = await startWorker(shared);

  // The first parse loads Docling's models, so it is done here under the long
  // hook timeout rather than inside whichever test happens to run first.
  const response = await upload('/v2/parse', 'clean-text-10p.pdf');
  if (response.status !== 200) {
    throw new Error(`the first parse failed: ${await response.text()}\n\n${worker.logs()}`);
  }
  parsed = (await response.json()) as Parsed;
}, 900_000);

afterAll(async () => {
  await worker?.stop();
  await Promise.all([
    new Promise((resolve) => models?.close(resolve)),
    new Promise((resolve) => hooks?.close(resolve)),
  ]);
  await Promise.all([postgres?.stop(), redisContainer?.stop(), minio?.stop()]);
}, 120_000);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function listen(server: Server): Promise<Server> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** `python -m konusbitr_worker`, configured the way the container is. */
async function startWorker(shared: Record<string, string>) {
  const port = await freePort();
  const output: string[] = [];

  const child: ChildProcess = spawn(
    'uv',
    ['run', '--project', WORKER_DIR, '--quiet', 'python', '-m', 'konusbitr_worker'],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...shared,
        // The repo's own `.env` must not leak in and point the worker at a
        // developer's local stack — or at their provider key.
        KONUSBITR_ENV_FILE: '/nonexistent/.env',
        LLM_PROVIDER: 'openai',
        LLM_API_KEY: '',
        LLM_BASE_URL: '',
        LLM_CHAT_MODEL: '',
        WORKER_PORT: String(port),
        WORKER_NAME: 'v2-fixtures-worker',
        WORKER_CONCURRENCY: '2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  child.stdout?.on('data', (chunk) => output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => output.push(String(chunk)));
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  const handle = {
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await gone;
    },
    logs: () => output.join(''),
  };

  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (((await response.json()) as { ok: boolean }).ok) return handle;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await handle.stop();
  throw new Error(`the worker never reported itself healthy\n\n${handle.logs()}`);
}

/** A multipart request carrying a fixture as its `file` part. */
function upload(path: string, fixture: string, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set(
    'file',
    new File([readFileSync(`${FIXTURES}/${fixture}`)], fixture, { type: 'application/pdf' }),
  );
  for (const [name, value] of Object.entries(fields)) form.set(name, value);

  return Promise.resolve(
    v2.fetch(
      new Request(`${APP_URL}${path}`, {
        method: 'POST',
        headers: { 'x-api-key': token },
        body: form,
      }),
    ),
  );
}

function call(app: App, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${APP_URL}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'x-api-key': token,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );
}

async function pollJob(jobId: string) {
  for (let attempt = 0; attempt < 480; attempt++) {
    const body = await (await call(v2, `/v2/jobs/${jobId}`)).json();
    if (body.status === 'succeeded' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`job ${jobId} never finished\n\n${worker.logs()}`);
}

/** The slug `sectionSlug` produces, restated so the test does not import it. */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** One real sentence from a real chunk of the parsed fixture. */
async function realPassage(docId: string) {
  const chunks = await chunksForDocument(db, docId);
  const chunk = chunks.find((row) => row.text.length > 80);
  if (!chunk) throw new Error('the parsed fixture produced no usable chunk');
  const pages = chunk.pages as { page: number }[];
  const quote = chunk.text.slice(0, 60).trim();
  return {
    chunkId: chunk.id,
    page: pages[0]?.page ?? 1,
    quote,
    // The quote's words with its punctuation taken out, which is what a person
    // would type. The sparse leg reads websearch syntax, so a heading's `#` and
    // `-` are operators there rather than text.
    question: `What does the document say about ${quote.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}?`,
  };
}

function cited(passage: { chunkId: string; page: number; quote: string }): string {
  const citation = { chunkId: passage.chunkId, page: passage.page, quote: passage.quote };
  return `It says so. [[${passage.chunkId}, ${passage.page}]]\n\n<citations>\n${JSON.stringify([
    citation,
  ])}\n</citations>`;
}

// ─── parse ───────────────────────────────────────────────────────────────────

describe('POST /v2/parse on a real document', () => {
  it('returns the documented shape, with every element located', () => {
    expect(Object.keys(parsed).sort()).toEqual(
      ['cached', 'contents', 'docId', 'images', 'markdown', 'pageCount'].sort(),
    );
    expect(parsed.docId).toMatch(/^doc_/);
    expect(parsed.pageCount).toBe(10);
    expect(parsed.cached).toBe(false);
    expect(parsed.markdown.length).toBeGreaterThan(500);
    expect(parsed.contents.length).toBeGreaterThan(10);

    for (const element of parsed.contents) {
      expect(element.page).toBeGreaterThanOrEqual(1);
      expect(element.page).toBeLessThanOrEqual(10);
      expect(element.bbox).toHaveLength(4);
    }
  });

  it('charged the first parse by its pages', async () => {
    const entries = await creditEntriesOf(db, orgId);
    const charge = entries.find((entry) => entry.reason === 'parse');
    expect(charge?.refId).toBe(parsed.docId);
    expect(charge?.delta).toBeLessThan(0);
  });

  it('serves the same bytes again instantly, for nothing, and records a cache_hit', async () => {
    const before = await creditEntriesOf(db, orgId);

    const started = Date.now();
    const response = await upload('/v2/parse', 'clean-text-10p.pdf');
    const elapsed = Date.now() - started;
    const again = (await response.json()) as Parsed;

    expect(response.status).toBe(200);
    expect(again.docId).toBe(parsed.docId);
    expect(again.cached).toBe(true);
    expect(again.markdown).toBe(parsed.markdown);
    // The worker took seconds to produce this the first time. A repeat that is
    // not served from the cache cannot come back this fast.
    expect(elapsed).toBeLessThan(2_000);

    const added = (await creditEntriesOf(db, orgId)).slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ reason: 'cache_hit', delta: 0, refId: parsed.docId });
  });

  it('refuses a file together with a docId, naming both', async () => {
    const response = await upload('/v2/parse', 'clean-text-10p.pdf', { docId: parsed.docId });

    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error.code).toBe('input_conflict');
    expect(error.message).toContain('file');
    expect(error.message).toContain('docId');
  });
});

// ─── split ───────────────────────────────────────────────────────────────────

describe('POST /v2/split on a real document', () => {
  it('cuts at the headings the parse found and names each output after one', async () => {
    const headings = parsed.contents.filter(
      (element) => element.type === 'heading' && element.level === 1,
    );
    // If this fails the fixture has no level-1 headings and the test below is
    // asserting nothing.
    expect(headings.length).toBeGreaterThan(1);

    const response = await call(v2, '/v2/split', { docId: parsed.docId, mode: 'semantic' });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);

    const documents = body.documents as { docId: string; name: string; pages: number[] }[];
    expect(documents.length).toBeGreaterThan(1);

    const realSlugs = new Set(headings.map((heading) => slug(heading.text ?? '')));
    for (const output of documents) {
      if (output.name === 'front-matter.pdf') continue;
      expect(realSlugs, output.name).toContain(output.name.replace(/\.pdf$/, ''));
    }

    // Between them the outputs cover the document, once.
    expect(documents.flatMap((output) => output.pages)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 1),
    );

    // And each is a real document: its own id, ready, readable, and parsed
    // without the worker being asked to read those pages a second time.
    const first = documents[0];
    if (!first) throw new Error('no outputs');
    expect(first.docId).not.toBe(parsed.docId);

    const read = await (await call(v2, `/v2/documents/${first.docId}`)).json();
    expect(read).toMatchObject({ docId: first.docId, status: 'ready', filename: first.name });
    expect(read.pageCount).toBe(first.pages.length);

    const child = (await (await call(v2, '/v2/parse', { docId: first.docId })).json()) as Parsed;
    expect(child.pageCount).toBe(first.pages.length);
    expect(child.contents.every((element) => element.page <= first.pages.length)).toBe(true);
  });

  it('cuts explicit ranges into PDFs with exactly those pages', async () => {
    const response = await call(v2, '/v2/split', {
      docId: parsed.docId,
      ranges: ['2-3', { start: 9, end: 10, name: 'appendix.pdf' }],
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);

    expect(
      (body.documents as { name: string; pages: number[] }[]).map((d) => [d.name, d.pages]),
    ).toEqual([
      ['pages-2-3.pdf', [2, 3]],
      ['appendix.pdf', [9, 10]],
    ]);
  });
});

// ─── ask, extract and the legacy endpoints ───────────────────────────────────

describe('answers over a real document', () => {
  it('returns a citation that verified against the real parse', async () => {
    const passage = await realPassage(parsed.docId);
    nextCompletion = cited(passage);

    const response = await call(v2, '/v2/ask', {
      docId: parsed.docId,
      question: passage.question,
    });
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0]).toMatchObject({ chunkId: passage.chunkId, page: passage.page });
    expect(body.citations[0].bbox).toHaveLength(4);
  });

  it('extracts a ten-field schema whose citations all verify', async () => {
    const sources = parsed.contents
      .filter((element) => element.type === 'paragraph' && (element.text ?? '').length > 60)
      .slice(0, 10);
    expect(sources).toHaveLength(10);

    const fields = sources.map((_, index) => `field${index}`);
    nextCompletion = JSON.stringify({
      result: Object.fromEntries(fields.map((field, index) => [field, `value ${index}`])),
      evidence: sources.map((source, index) => ({
        schemaPath: `result.field${index}`,
        quote: (source.text ?? '').slice(0, 60).trim(),
        page: source.page,
      })),
    });

    const response = await call(v2, '/v2/extract', {
      docId: parsed.docId,
      schema: {
        type: 'object',
        properties: Object.fromEntries(
          fields.map((field) => [field, { type: 'string', description: `The ${field}.` }]),
        ),
      },
    });
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.unverified).toEqual([]);
    expect(body.citations).toHaveLength(10);
    expect(Object.values(body.result).every((value) => value !== null)).toBe(true);
  });

  it('answers the legacy chat-with-pdf call in the legacy shape', async () => {
    const passage = await realPassage(parsed.docId);
    nextCompletion = cited(passage);

    const response = await call(v1, '/v1/chat-with-pdf', {
      docId: parsed.docId,
      question: passage.question,
    });
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.content).toContain('It says so.');
    expect(body.references.length).toBeGreaterThan(0);
  });

  it('answers the legacy chat-with-all-pdfs call across the corpus', async () => {
    const passage = await realPassage(parsed.docId);
    nextCompletion = cited(passage);

    const response = await call(v1, '/v1/chat-with-all-pdfs', { question: passage.question });
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.content).toContain('It says so.');
  });
});

// ─── async ───────────────────────────────────────────────────────────────────

describe('?async=true on a real document', () => {
  it('returns a job id at once, parses behind it, and signs the webhook', async () => {
    deliveries = [];

    const started = Date.now();
    const accepted = await upload('/v2/parse?async=true', 'tables-financial.pdf', {
      webhook_url: hookUrl,
    });
    const elapsed = Date.now() - started;

    expect(accepted.status).toBe(202);
    const { jobId } = await accepted.json();
    expect(jobId).toMatch(/^ajob_/);
    // It did not wait for the parse.
    expect(elapsed).toBeLessThan(2_000);

    const finished = await pollJob(jobId);
    expect(finished.status, JSON.stringify(finished.error)).toBe('succeeded');
    expect(finished.result.pageCount).toBeGreaterThan(0);
    expect(
      (finished.result.contents as Element[]).some((element) => element.type === 'table'),
    ).toBe(true);

    let delivered: (typeof deliveries)[number] | undefined;
    for (let attempt = 0; attempt < 100 && !delivered; attempt++) {
      delivered = deliveries.find((entry) => entry.body.includes(jobId));
      if (!delivered) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!delivered) throw new Error('the webhook was never delivered');

    // Verified the way a receiver would, from the documented recipe rather
    // than with our own helper: HMAC-SHA256 over `${timestamp}.${body}`.
    const { verifyWebhook } = await import('@/lib/v2/webhooks');
    expect(
      verifyWebhook(delivered.body, {
        signature: delivered.signature,
        timestamp: delivered.timestamp,
      }),
    ).toBe(true);
    expect(
      verifyWebhook(`${delivered.body} `, {
        signature: delivered.signature,
        timestamp: delivered.timestamp,
      }),
    ).toBe(false);

    expect(JSON.parse(delivered.body)).toMatchObject({
      jobId,
      kind: 'parse',
      status: 'succeeded',
    });
  });
});

// ─── credits ─────────────────────────────────────────────────────────────────

describe('CREDITS_MODE=unlimited over the whole run', () => {
  it('recorded every operation and refused none', async () => {
    const entries = await creditEntriesOf(db, orgId);
    const reasons = new Set(entries.map((entry) => entry.reason));

    for (const reason of ['parse', 'cache_hit', 'split', 'ask', 'extract']) {
      expect(reasons, reason).toContain(reason);
    }
    // No grant was ever made, so the balance is negative — and nothing above
    // was refused for it.
    expect(entries.reduce((sum, entry) => sum + entry.delta, 0)).toBeLessThan(0);
  });
});
