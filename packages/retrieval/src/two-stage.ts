import type { Database } from '@konusbitr/db';
import * as schema from '@konusbitr/db/schema';
import type { Env } from '@konusbitr/shared';
import { and, count, eq, isNotNull, sql } from 'drizzle-orm';
import type { Scope } from './types.js';

export type TwoStageOptions = {
  db: Database;
  orgId: string;
  scope: Scope;
  queryVector: number[];
  threshold?: number;
  env?: Env;
};

/** How many documents the summary stage narrows a large corpus down to. */
export const TWO_STAGE_DOCUMENT_LIMIT = 10;

export type CorpusSizeOptions = {
  db: Database;
  orgId: string;
  scope: Scope;
  threshold?: number;
  env?: Env;
};

/**
 * Decide whether this corpus is large enough to be worth the summary stage.
 *
 * Split out from the search itself because the answer does not depend on the
 * query: multi-query expansion runs the chunk search several times per call and
 * would otherwise repeat this `COUNT(*)` once per variant.
 */
export async function shouldUseTwoStage(options: CorpusSizeOptions): Promise<boolean> {
  const { db, orgId, scope, threshold, env } = options;

  if (scope.kind === 'document') {
    return false;
  }

  const limitThreshold = threshold ?? env?.CORPUS_TWO_STAGE_THRESHOLD ?? 200;

  const docFilters = [eq(schema.documents.orgId, orgId)];
  if (scope.folderId) {
    docFilters.push(eq(schema.documents.folderId, scope.folderId));
  }

  const [countRow] = await db
    .select({ total: count() })
    .from(schema.documents)
    .where(and(...docFilters));

  return (countRow?.total ?? 0) > limitThreshold;
}

/**
 * Rank documents by the cosine distance of their summary embedding, and return
 * the closest `TWO_STAGE_DOCUMENT_LIMIT` of them.
 *
 * Document summaries are written at ingest by the worker's summarize step and
 * embedded into `document_embeddings`.
 */
export async function topDocumentIdsBySummary(options: {
  db: Database;
  orgId: string;
  scope: Scope;
  queryVector: number[];
  limit?: number;
}): Promise<string[]> {
  const { db, orgId, scope, queryVector, limit = TWO_STAGE_DOCUMENT_LIMIT } = options;

  const vectorLiteral = `[${queryVector.join(',')}]`;
  const distanceSql = sql<number>`${schema.documentEmbeddings.embedding} <=> ${vectorLiteral}::vector`;

  const embeddingFilters = [
    eq(schema.documentEmbeddings.orgId, orgId),
    isNotNull(schema.documentEmbeddings.embedding),
  ];

  if (scope.kind === 'corpus' && scope.folderId) {
    const folderDocs = db
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(and(eq(schema.documents.orgId, orgId), eq(schema.documents.folderId, scope.folderId)));
    embeddingFilters.push(sql`${schema.documentEmbeddings.documentId} IN (${folderDocs})`);
  }

  const topDocs = await db
    .select({ documentId: schema.documentEmbeddings.documentId })
    .from(schema.documentEmbeddings)
    .where(and(...embeddingFilters))
    .orderBy(distanceSql)
    .limit(limit);

  return topDocs.map((r) => r.documentId);
}

/**
 * Perform two-stage document filtering for large corpora.
 *
 * If the corpus contains more documents than `CORPUS_TWO_STAGE_THRESHOLD`
 * (default 200), first search `document_embeddings` by cosine similarity to
 * select the top 10 candidate documents; chunk-level retrieval is then confined
 * to those documents.
 *
 * Returns the candidate document ids, or `undefined` when the corpus is small
 * enough to search whole.
 */
export async function getTwoStageCandidateDocumentIds(
  options: TwoStageOptions,
): Promise<string[] | undefined> {
  if (!(await shouldUseTwoStage(options))) {
    return undefined;
  }
  return topDocumentIdsBySummary(options);
}
