import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createDb, type Database, migrate, scopedDb } from '@konusbitr/db';
import {
  createOrganization,
  ensureExtensions,
  pagesForDocument,
  parseResultsForDocument,
} from '@konusbitr/db/testing';
import { JOBS_DEAD_LETTER, JOBS_STREAM, JOBS_STREAM_FIELD } from '@konusbitr/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The seam, end to end: TypeScript enqueues, Python processes, the browser watches.
 *
 * This is the only test in the repository that runs both runtimes at once, and
 * it is the point of Phase 06. Everything below is real — a real Postgres with
 * the real migrations, a real Redis stream, a real MinIO, and the actual worker
 * started the way Compose starts it. The stub pipeline is the only fake, and
 * Phase 07 replaces its body without touching anything asserted here.
 *
 * What it is here to prove, in the language of the phase's acceptance criteria:
 * the worker comes up healthy and ready; an enqueued document reaches `ready`;
 * progress arrives over SSE and a mid-job reconnect resumes rather than
 * restarting; killing the worker mid-job and restarting it completes the job
 * exactly once; and a payload that fails schema validation is dead-lettered
 * instead of being retried forever.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const WORKER_DIR = `${REPO_ROOT}/services/worker`;

const APP_URL = 'http://localhost:3000';
const BUCKET = 'konusbitr-test';
const MINIO_ROOT = 'konusbitr-root';
const MINIO_SECRET = 'konusbitr-root-secret';

/**
 * Long enough to catch a job in the middle of one.
 *
 * Seven stages at this pace is a job of roughly two and a half seconds, which
 * is what makes "read the progress halfway" and "kill it halfway" possible to
 * write without racing.
 */
const STAGE_SECONDS = 0.35;

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let minio: StartedTestContainer;
let db: Database;
let redis: Redis;
let worker: Worker;

let databaseUrl: string;
let redisUrl: string;
let s3Endpoint: string;

let orgId: string;
let apiKey: string;

let enqueueParseJob: typeof import('@/lib/ingest/queue').enqueueParseJob;
let events: (
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) => Promise<Response>;
let failedJobs: (request: Request, context: { params: Promise<unknown> }) => Promise<Response>;

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

  databaseUrl = postgres.getConnectionUri();
  redisUrl = redisContainer.getConnectionUrl();
  s3Endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;

  db = createDb(databaseUrl);
  await ensureExtensions(db);
  await migrate(databaseUrl);

  redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  Object.assign(process.env, {
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
    AUTH_SECRET: 'konusbitr-development-secret-change-me',
  });

  // Imported only now: these modules read the environment as they load, which
  // is the same "fail loudly at boot" behaviour the server has.
  enqueueParseJob = (await import('@/lib/ingest/queue')).enqueueParseJob;
  events = (await import('@/app/api/documents/[documentId]/events/route')).GET as typeof events;
  failedJobs = (await import('@/app/api/admin/jobs/failed/route')).GET as typeof failedJobs;

  const { generateApiKey } = await import('@/lib/auth/api-key');
  const organization = await createOrganization(db, 'Worker Test', 'worker-test');
  orgId = organization.id;

  const generated = generateApiKey();
  await scopedDb(db, orgId).createApiKey({
    name: 'worker test key',
    hashedKey: generated.hashedKey,
    prefix: generated.prefix,
    scopes: ['documents:read', 'documents:write'],
  });
  apiKey = generated.token;

  worker = await startWorker();
}, 600_000);

afterAll(async () => {
  await worker?.stop();
  redis?.disconnect();
  await Promise.all([postgres?.stop(), redisContainer?.stop(), minio?.stop()]);
}, 120_000);

// ─── Running the Python worker ───────────────────────────────────────────────

type Worker = {
  port: number;
  /** SIGTERM, and wait for the process to actually go. */
  stop(): Promise<void>;
  /** SIGKILL: what a crashed worker looks like, with no chance to clean up. */
  kill(): Promise<void>;
  logs(): string;
};

/**
 * Start the worker exactly as the container does: `python -m konusbitr_worker`,
 * configured entirely through the environment.
 *
 * `WORKER_NAME` is pinned rather than left to the hostname because a restart
 * has to rejoin the consumer group under the *same* name — that is how a
 * worker finds the delivery it was holding when it died, and the whole
 * "completes exactly once" criterion rests on it.
 */
async function startWorker(): Promise<Worker> {
  const port = await freePort();
  const output: string[] = [];

  const child: ChildProcess = spawn(
    'uv',
    ['run', '--project', WORKER_DIR, '--quiet', 'python', '-m', 'konusbitr_worker'],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // The repo's own `.env` must not leak in and point the worker at a
        // developer's local stack instead of at these containers.
        KONUSBITR_ENV_FILE: '/nonexistent/.env',
        NODE_ENV: 'test',
        APP_URL,
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        S3_ENDPOINT: s3Endpoint,
        S3_BUCKET: BUCKET,
        S3_ACCESS_KEY_ID: MINIO_ROOT,
        S3_SECRET_ACCESS_KEY: MINIO_SECRET,
        S3_FORCE_PATH_STYLE: 'true',
        WORKER_PORT: String(port),
        WORKER_NAME: 'integration-worker',
        WORKER_CONCURRENCY: '2',
        WORKER_RETRY_BASE_SECONDS: '1',
        WORKER_STUB_STAGE_SECONDS: String(STAGE_SECONDS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  child.stdout?.on('data', (chunk) => output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => output.push(String(chunk)));

  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await gone;
  };

  const handle: Worker = {
    port,
    stop,
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
      await gone;
    },
    logs: () => output.join(''),
  };

  try {
    await waitFor(
      async () => (await health(port))?.ok === true,
      60_000,
      'the worker never reported itself healthy',
    );
  } catch (error) {
    await handle.kill();
    throw new Error(`${(error as Error).message}\n\n${handle.logs()}`);
  }

  return handle;
}

async function health(port: number): Promise<{ ok: boolean } | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return (await response.json()) as { ok: boolean };
  } catch {
    return undefined;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;

/** A queued document and its job row, as the intake path would leave them. */
async function queuedDocument(pageCount = 2) {
  const scoped = scopedDb(db, orgId);
  const suffix = String(++seq).padStart(4, '0');
  const contentHash = `${'0'.repeat(60)}${suffix}`;

  const document = await scoped.createDocument({
    filename: `report-${suffix}.pdf`,
    mime: 'application/pdf',
    byteSize: 2048,
    pageCount,
    storageKey: `orgs/${orgId}/documents/doc-${suffix}/original.pdf`,
    contentHash,
    settingsHash: `${'f'.repeat(60)}${suffix}`,
    status: 'queued',
  });
  if (!document) throw new Error('the document row could not be created');

  const job = await scoped.createJob({ documentId: document.id, type: 'parse' });
  if (!job) throw new Error('the job row could not be created');

  return { document, job };
}

async function enqueue(fixture: Awaited<ReturnType<typeof queuedDocument>>) {
  await enqueueParseJob({
    jobId: fixture.job.id,
    orgId,
    documentId: fixture.document.id,
    storageKey: fixture.document.storageKey,
    contentHash: fixture.document.contentHash,
    settings: { quality: 'standard', langList: [], llm: false },
  });
}

async function documentRow(documentId: string) {
  const row = await scopedDb(db, orgId).documentById(documentId);
  if (!row) throw new Error(`document ${documentId} disappeared`);
  return row;
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${description}`);
}

const waitForStatus = (documentId: string, status: string, timeoutMs = 60_000) =>
  waitFor(
    async () => (await documentRow(documentId)).status === status,
    timeoutMs,
    `document ${documentId} to reach ${status}`,
  );

/** Call an authenticated route handler the way a client would. */
function call(
  handler: (request: Request, context: { params: Promise<never> }) => Promise<Response>,
  params: unknown = {},
): Promise<Response> {
  return handler(new Request(`${APP_URL}/api/x`, { headers: { 'x-api-key': apiKey } }), {
    params: Promise.resolve(params),
  } as { params: Promise<never> });
}

/** Read SSE frames until `done`, or until `limit` frames have arrived. */
async function readEvents(
  response: Response,
  limit: number,
): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('the SSE response had no body');

  const decoder = new TextDecoder();
  const frames: { event: string; data: Record<string, unknown> }[] = [];
  let buffer = '';

  try {
    while (frames.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        const name = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (name && data) frames.push({ event: name, data: JSON.parse(data) });
      }

      if (frames.some((frame) => frame.event === 'done')) break;
    }
  } finally {
    await reader.cancel();
  }

  return frames;
}

// ─── The criteria ────────────────────────────────────────────────────────────

describe('the worker comes up', () => {
  it('reports itself healthy, with the loop turning and Redis reachable', async () => {
    const response = await fetch(`http://127.0.0.1:${worker.port}/health`);
    const body = (await response.json()) as {
      ok: boolean;
      checks: Record<string, unknown>;
      worker: { consumer: string; concurrency: number };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.loop).toBe(true);
    expect(body.checks.redis).toBe(true);
    expect(body.worker.consumer).toBe('integration-worker');
    expect(body.worker.concurrency).toBe(2);
  });

  it('reports itself ready, having reached Postgres, Redis and storage', async () => {
    const response = await fetch(`http://127.0.0.1:${worker.port}/ready`);
    const body = (await response.json()) as { ok: boolean; checks: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.checks).toEqual({ postgres: true, redis: true, storage: true });
    expect(body.ok).toBe(true);
  });
});

describe('a document goes from queued to ready', () => {
  it('drives the whole pipeline and writes what a parse writes', async () => {
    const fixture = await queuedDocument(3);
    await enqueue(fixture);

    await waitForStatus(fixture.document.id, 'ready');

    const row = await documentRow(fixture.document.id);
    expect(row.status).toBe('ready');
    expect(row.pageCount).toBe(3);
    expect(row.error).toBeNull();
    expect(row.errorCode).toBeNull();

    expect(await parseResultsForDocument(db, fixture.document.id)).toHaveLength(1);
    expect(await pagesForDocument(db, fixture.document.id)).toHaveLength(3);

    const job = await scopedDb(db, orgId).latestJobForDocument(fixture.document.id);
    expect(job?.status).toBe('succeeded');
    expect(job?.stage).toBe('ready');
    expect(job?.progress).toBe(100);
    expect(job?.attempts).toBe(1);
  });

  it('acknowledges the entry, so nothing is left pending', async () => {
    const fixture = await queuedDocument(1);
    await enqueue(fixture);
    await waitForStatus(fixture.document.id, 'ready');

    // Give the acknowledgement a moment; it is the last thing the loop does.
    await waitFor(
      async () => (await pendingCount()) === 0,
      10_000,
      'the pending-entries list to drain',
    );
    expect(await pendingCount()).toBe(0);
  });
});

async function pendingCount(): Promise<number> {
  const summary = (await redis.xpending(JOBS_STREAM, 'konusbitr:workers')) as
    | [number, ...unknown[]]
    | null;
  return summary ? Number(summary[0]) : 0;
}

describe('the browser watches over SSE', () => {
  it('streams progress and closes on ready', async () => {
    const fixture = await queuedDocument(1);
    const response = await call(events, { documentId: fixture.document.id });
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    // Enqueued only after the stream is open, so no event can be missed.
    const frames = readEvents(response, 40);
    await enqueue(fixture);
    const received = await frames;

    const stages = received
      .filter((frame) => frame.event === 'progress')
      .map((frame) => frame.data.stage);

    // The first frame is the replay, which may already say `fetching` — the
    // worker blocks on the stream and can start the job between the enqueue
    // and the route reading the row. What matters is that it is a live,
    // non-terminal stage rather than nothing at all.
    expect(stages[0]).not.toBeUndefined();
    expect(['queued', 'fetching']).toContain(stages[0]);
    expect(stages).toContain('parsing');
    expect(stages).toContain('ocr');
    expect(stages).toContain('embedding');
    expect(stages.at(-1)).toBe('ready');
    expect(received.at(-1)?.event).toBe('done');
  });

  it('replays current state on reconnect, so a mid-job refresh resumes', async () => {
    const fixture = await queuedDocument(1);
    await enqueue(fixture);

    // Wait until the job is genuinely under way, then connect as a freshly
    // reloaded page would — having missed every event so far.
    await waitFor(
      async () => (await documentRow(fixture.document.id)).status !== 'queued',
      30_000,
      'the job to start',
    );

    const response = await call(events, { documentId: fixture.document.id });
    const [first] = await readEvents(response, 1);

    expect(first?.event).toBe('progress');
    expect(first?.data.stage).not.toBe('queued');
    expect(first?.data.percent as number).toBeGreaterThan(0);

    await waitForStatus(fixture.document.id, 'ready');
  });

  it('closes immediately for a document that is already finished', async () => {
    const fixture = await queuedDocument(1);
    await enqueue(fixture);
    await waitForStatus(fixture.document.id, 'ready');

    const frames = await readEvents(await call(events, { documentId: fixture.document.id }), 5);

    expect(frames.map((frame) => frame.event)).toEqual(['progress', 'done']);
    expect(frames[0]?.data.stage).toBe('ready');
  });

  it('is 404 for another organization, not 403', async () => {
    const other = await createOrganization(db, 'Somebody Else', `other-${Date.now()}`);
    const theirs = await scopedDb(db, other.id).createDocument({
      filename: 'theirs.pdf',
      mime: 'application/pdf',
      byteSize: 10,
      storageKey: `orgs/${other.id}/documents/x/original.pdf`,
      contentHash: 'e'.repeat(64),
      settingsHash: 'e'.repeat(64),
    });

    const response = await call(events, { documentId: theirs?.id });
    expect(response.status).toBe(404);
  });
});

describe('crash recovery', () => {
  it('completes a job exactly once when the worker is killed mid-job', async () => {
    const fixture = await queuedDocument(4);
    await enqueue(fixture);

    // Killed with SIGKILL, so nothing is acknowledged and nothing is cleaned
    // up: the delivery is left in the consumer group's pending list, which is
    // exactly the state a crashed container leaves behind.
    await waitFor(
      async () => (await documentRow(fixture.document.id)).status !== 'queued',
      30_000,
      'the job to start before the worker is killed',
    );
    await worker.kill();

    const row = await documentRow(fixture.document.id);
    expect(row.status).not.toBe('ready');
    expect(await pendingCount()).toBe(1);

    // The same consumer name, so it finds its own unfinished delivery.
    worker = await startWorker();
    await waitForStatus(fixture.document.id, 'ready');

    expect(await parseResultsForDocument(db, fixture.document.id)).toHaveLength(1);
    expect(await pagesForDocument(db, fixture.document.id)).toHaveLength(4);
  }, 180_000);

  it('does the work once when the same entry is delivered twice', async () => {
    const fixture = await queuedDocument(2);
    await enqueue(fixture);
    await waitForStatus(fixture.document.id, 'ready');

    // A duplicate delivery of the same job, which is what an at-least-once
    // transport is allowed to do at any time.
    await enqueue(fixture);
    await waitFor(
      async () => (await pendingCount()) === 0,
      30_000,
      'the duplicate delivery to be concluded',
    );

    expect(await parseResultsForDocument(db, fixture.document.id)).toHaveLength(1);
    expect(await pagesForDocument(db, fixture.document.id)).toHaveLength(2);
    expect((await documentRow(fixture.document.id)).status).toBe('ready');
  }, 120_000);
});

describe('a payload that cannot be read', () => {
  it('is dead-lettered rather than retried forever', async () => {
    const before = await redis.llen(JOBS_DEAD_LETTER);

    await redis.xadd(
      JOBS_STREAM,
      '*',
      JOBS_STREAM_FIELD,
      JSON.stringify({ v: 1, jobId: 'job_nonsense', type: 'parse' }),
    );

    await waitFor(
      async () => (await redis.llen(JOBS_DEAD_LETTER)) > before,
      30_000,
      'the malformed entry to be dead-lettered',
    );

    // Acknowledged, so it will never come back round.
    await waitFor(
      async () => (await pendingCount()) === 0,
      15_000,
      'the malformed entry to be acknowledged',
    );

    const [newest] = await redis.lrange(JOBS_DEAD_LETTER, 0, 0);
    const entry = JSON.parse(newest ?? '{}') as { errorCode: string; error: string };
    expect(entry.errorCode).toBe('invalid_payload');
    // The message names the field, so an operator can tell which side is wrong.
    expect(entry.error).toContain('orgId');
  }, 90_000);

  it('is not readable through GET /api/admin/jobs/failed with an API key', async () => {
    /*
     * The operator view is instance-wide — it renders envelopes that never
     * became a job row and therefore belong to no organization in particular
     * — so it is `owner`-only and closed to API keys. A key carries no person
     * and the least-privileged role, and neither is the right thing to show
     * every tenant's dead letters to.
     */
    const response = await call(failedJobs);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'session_required',
    );
  });
});
