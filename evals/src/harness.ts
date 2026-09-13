import { createDb, type Database } from '@konusbitr/db';
import { migrate } from '@konusbitr/db/migrate';
import * as schema from '@konusbitr/db/schema';
import { ensureExtensions } from '@konusbitr/db/testing';
import { hashingEmbed, hashingEmbedder } from '@konusbitr/retrieval/testing';
import { type Env, parseEnv } from '@konusbitr/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { buildEvalChunks, type ChunkingMode, type EvalChunk, loadFixtureCorpus } from './corpus.js';

export const EVAL_ORG_ID = 'org_eval_fixture_corpus';

/** A database with the fixture corpus indexed in it, and the pieces to query it. */
export type EvalHarness = {
  db: Database;
  env: Env;
  orgId: string;
  chunks: EvalChunk[];
  embed: (text: string) => Promise<number[]>;
  stop: () => Promise<void>;
};

/**
 * Stand up a throwaway Postgres with pgvector, migrate it, and index the fixture
 * corpus into it.
 *
 * This is the whole point of the rewrite: `pnpm eval:retrieval` runs the real
 * `retrieve()` against real SQL, so the numbers it prints describe the pipeline
 * that ships. An eval that simulates its own retrieval measures the simulator.
 *
 * Set `DATABASE_URL_EVAL` to point at a database you already have — otherwise a
 * container is started and thrown away.
 */
export async function startEvalHarness(
  options: {
    mode?: ChunkingMode;
    chunks?: EvalChunk[];
    /** Skip writing vectors, to model a deployment with no embedding model. */
    withVectors?: boolean;
  } = {},
): Promise<EvalHarness> {
  const { mode = 'page', withVectors = true } = options;

  let container: StartedPostgreSqlContainer | undefined;
  let uri = process.env.DATABASE_URL_EVAL;

  if (!uri) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    container = await new PostgreSqlContainer('pgvector/pgvector:pg17')
      .withCommand(['postgres', '-c', 'shared_preload_libraries=', '-c', 'max_connections=50'])
      .start();
    uri = container.getConnectionUri();
  }

  const db = createDb(uri, { quiet: true });
  await ensureExtensions(db);
  await migrate(uri);

  const env = parseEnv({
    APP_URL: 'http://localhost:3000',
    DATABASE_URL: uri,
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'konusbitr',
    S3_ACCESS_KEY_ID: 'konusbitr',
    S3_SECRET_ACCESS_KEY: 'konusbitr-dev-secret',
  });

  const corpus = loadFixtureCorpus();
  const chunks = options.chunks ?? buildEvalChunks(corpus, mode);

  await db
    .insert(schema.organizations)
    .values({ id: EVAL_ORG_ID, name: 'Eval Fixture Corpus', slug: 'eval-fixture-corpus' })
    .onConflictDoNothing();

  // Every document a chunk points at, not only the fixture documents: the
  // latency benchmark synthesises its own, and `chunks.document_id` is a foreign
  // key, so a missing row fails the whole insert rather than that one chunk.
  const pageCounts = new Map<string, number>();
  for (const [documentId, pages] of Object.entries(corpus)) {
    pageCounts.set(documentId, pages.length);
  }
  for (const chunk of chunks) {
    const highest = Math.max(...chunk.pages.map((page) => page.page));
    pageCounts.set(chunk.documentId, Math.max(pageCounts.get(chunk.documentId) ?? 0, highest));
  }

  for (const [documentId, pageCount] of pageCounts) {
    await db
      .insert(schema.documents)
      .values({
        id: documentId,
        orgId: EVAL_ORG_ID,
        filename: `${documentId}.pdf`,
        mime: 'application/pdf',
        byteSize: 1,
        storageKey: `orgs/${EVAL_ORG_ID}/documents/${documentId}/original.pdf`,
        contentHash: `eval-${documentId}`,
        settingsHash: 'eval',
        status: 'ready',
        pageCount,
      })
      .onConflictDoNothing();
  }

  // Batched: a single insert of every chunk exceeds the bind-parameter limit on
  // the 100k-chunk benchmark.
  const BATCH = 500;
  for (let i = 0; i < chunks.length; i += BATCH) {
    await db.insert(schema.chunks).values(
      chunks.slice(i, i + BATCH).map((chunk) => ({
        id: chunk.id,
        documentId: chunk.documentId,
        orgId: EVAL_ORG_ID,
        ordinal: chunk.ordinal,
        text: chunk.text,
        sectionPath: chunk.sectionPath,
        pages: chunk.pages,
        tokenCount: chunk.tokenCount,
        embedding: withVectors ? hashingEmbed(chunk.text) : null,
      })),
    );
  }

  return {
    db,
    env,
    orgId: EVAL_ORG_ID,
    chunks,
    embed: hashingEmbedder(),
    stop: async () => {
      await container?.stop();
    },
  };
}
