import { canResolveModel, embedQuery } from '@konusbitr/ai';
import { createDb, type Database } from '@konusbitr/db';
import { loadEnv } from '@konusbitr/shared';
import { searchDense } from './dense.js';
import { applyDiversityCap } from './diversity.js';
import { reciprocalRankFusion } from './fusion.js';
import { generateHydePassage } from './hyde.js';
import { generateQueryVariants } from './multi-query.js';
import { applyReranking } from './rerank.js';
import { rewriteQuery } from './rewrite.js';
import { searchSparse } from './sparse.js';
import { shouldUseTwoStage, topDocumentIdsBySummary } from './two-stage.js';
import type { RetrievedChunk, RetrieveOptions } from './types.js';

/**
 * One pool per database URL.
 *
 * Keyed rather than a single slot: a process that talks to two databases — the
 * eval harness against a scratch container while the app holds its own — would
 * otherwise get whichever one asked first, silently.
 */
const dbPool = new Map<string, Database>();

function getDb(databaseUrl: string): Database {
  let db = dbPool.get(databaseUrl);
  if (!db) {
    db = createDb(databaseUrl);
    dbPool.set(databaseUrl, db);
  }
  return db;
}

/**
 * Run the two retrieval legs and tolerate one of them failing, but not both.
 *
 * A leg returning nothing is ordinary: a corpus with no vectors yet has no
 * dense results, and that is a supported state. A leg *throwing* is a bug, and
 * swallowing it unconditionally is how a broken dense query turns into silently
 * keyword-only retrieval that still looks healthy. So a single failure degrades
 * with the reason attached, and a total failure raises.
 */
async function runLegs(
  legs: readonly { name: string; run: () => Promise<RetrievedChunk[]> }[],
): Promise<{ lists: RetrievedChunk[][]; failures: { name: string; error: unknown }[] }> {
  const settled = await Promise.allSettled(legs.map((leg) => leg.run()));

  const lists: RetrievedChunk[][] = [];
  const failures: { name: string; error: unknown }[] = [];

  settled.forEach((outcome, index) => {
    const name = legs[index]?.name ?? 'unknown';
    if (outcome.status === 'fulfilled') {
      lists.push(outcome.value);
    } else {
      failures.push({ name, error: outcome.reason });
    }
  });

  if (lists.length === 0 && failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `retrieval failed: every leg errored (${failures.map((f) => f.name).join(', ')})`,
    );
  }

  return { lists, failures };
}

/**
 * Main retrieval service entrypoint.
 *
 * Given a question and a scope (document or corpus/folder), executes:
 * 1. Query rewriting (if conversation history is provided).
 * 2. Multi-query expansion (if enabled or corpus mode).
 * 3. Dense vector search via pgvector HNSW (with HyDE if enabled).
 * 4. Sparse full-text keyword search via Postgres FTS over `tsv`.
 * 5. Reciprocal Rank Fusion (RRF, k=60) merging candidates.
 * 6. Cross-encoder reranking (BGE-reranker or Cohere, with graceful fallback).
 * 7. Diversity capping (max 3 chunks per doc in corpus mode).
 *
 * Returns up to `topK` (default 8) chunks with preserved page and bounding-box coordinates.
 */
export async function retrieve(options: RetrieveOptions): Promise<RetrievedChunk[]> {
  const env = options.env ?? loadEnv();
  const db = options.db ?? getDb(env.DATABASE_URL);
  const topK = options.topK ?? 8;
  const { orgId, scope } = options;

  // 1. Query rewriting: collapse multi-turn history into standalone query
  const effectiveQuery = await rewriteQuery(options);

  // 2. Query expansion: check if multi-query is requested
  const isMultiQuery =
    options.multiQueryEnabled ?? (scope.kind === 'corpus' && (env.MULTI_QUERY_ENABLED ?? false));

  const queries = isMultiQuery
    ? await generateQueryVariants(effectiveQuery, env)
    : [effectiveQuery];

  // Whether the corpus is large enough for the summary stage does not depend on
  // the query, so it is decided once rather than once per expanded variant.
  const twoStage =
    scope.kind === 'corpus' &&
    (await shouldUseTwoStage({ db, orgId, scope, env }).catch(() => false));

  // 3. Dense search setup & HyDE
  const isHyde = options.hydeEnabled ?? env.HYDE_ENABLED ?? false;
  const embed =
    options.embed ??
    (canResolveModel(env, 'embedding') ? (text: string) => embedQuery(text, { env }) : undefined);

  // Multi-query list accumulator for fusion
  const queryResultLists: RetrievedChunk[][] = [];

  for (const q of queries) {
    let queryVector: number[] | undefined;
    if (embed) {
      try {
        const textToEmbed = isHyde ? await generateHydePassage(q, env) : q;
        queryVector = await embed(textToEmbed);
      } catch (error) {
        // Fall back to keyword-only search if embedding fails
        options.onLegError?.('embedding', error);
        queryVector = undefined;
      }
    }

    // 4. Two-stage candidate filtering for large corpora
    let candidateDocumentIds: string[] | undefined;
    if (queryVector && twoStage) {
      candidateDocumentIds = await topDocumentIdsBySummary({ db, orgId, scope, queryVector });
    }

    // 5. Parallel dense and sparse search legs
    const enabledLegs = options.legs ?? (['dense', 'sparse'] as const);
    const legs: { name: string; run: () => Promise<RetrievedChunk[]> }[] = [];

    if (enabledLegs.includes('sparse')) {
      legs.push({
        name: 'sparse',
        run: () => searchSparse({ db, orgId, scope, query: q, limit: 40, candidateDocumentIds }),
      });
    }

    if (queryVector && enabledLegs.includes('dense')) {
      const vector = queryVector;
      legs.unshift({
        name: 'dense',
        run: () =>
          searchDense({
            db,
            orgId,
            scope,
            queryVector: vector,
            limit: 40,
            efSearch: options.efSearch ?? env.HNSW_EF_SEARCH,
            candidateDocumentIds,
          }),
      });
    }

    const { lists, failures } = await runLegs(legs);
    for (const failure of failures) {
      options.onLegError?.(failure.name, failure.error);
    }

    // 6. Fuse dense and sparse legs via RRF
    queryResultLists.push(reciprocalRankFusion(lists, { k: 60, limit: 50 }));
  }

  // If multiple queries ran, fuse their lists together
  const initialCandidates =
    queryResultLists.length === 1
      ? (queryResultLists[0] ?? [])
      : reciprocalRankFusion(queryResultLists, { k: 60, limit: 50 });

  if (initialCandidates.length === 0) {
    return [];
  }

  // 7. Cross-encoder rerank top 50 candidates
  const reranked = await applyReranking({
    query: effectiveQuery,
    candidates: initialCandidates,
    topK: Math.max(topK * 2, 50),
    rerankEnabled: options.rerankEnabled,
    env,
  });

  // 8. Diversity cap: in corpus mode, max 3 chunks per document
  const diversified = applyDiversityCap(reranked, scope, topK);

  return diversified.slice(0, topK);
}
