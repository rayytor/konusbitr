import type { Database, Transaction } from '@konusbitr/db';
import * as schema from '@konusbitr/db/schema';
import type { ChunkMeta, ChunkPage } from '@konusbitr/shared';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { RetrievedChunk, Scope } from './types.js';

export type DenseSearchOptions = {
  db: Database;
  orgId: string;
  scope: Scope;
  queryVector: number[];
  limit?: number;
  efSearch?: number;
  candidateDocumentIds?: string[];
};

/**
 * Perform dense vector similarity search using pgvector HNSW index.
 *
 * Filters by orgId and scope (document, folder, or two-stage candidate list).
 * Scores results by cosine similarity (1.0 - cosine_distance).
 *
 * When `efSearch` is given the search runs inside a transaction, because
 * `hnsw.ef_search` has to be set with `SET LOCAL` to stay scoped to this one
 * query, and `SET LOCAL` outside a transaction block is a no-op that Postgres
 * reports only as a warning. See `docs/retrieval.md`.
 */
export async function searchDense(options: DenseSearchOptions): Promise<RetrievedChunk[]> {
  const { db, efSearch } = options;

  // `SET` is a utility statement: Postgres accepts no bind parameter for its
  // value, so the number reaches SQL as text. That makes this the one place in
  // the package where a value is interpolated, which is why anything that is
  // not a usable integer is dropped here rather than becoming a syntax error at
  // the far end.
  const bounded = boundedEfSearch(efSearch);
  if (bounded === undefined) {
    return runDenseQuery(db, options);
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${bounded}`));
    return runDenseQuery(tx, options);
  });
}

/** `ef_search` as an integer pgvector will accept, or nothing. */
function boundedEfSearch(efSearch: number | undefined): number | undefined {
  if (efSearch === undefined || !Number.isFinite(efSearch)) {
    return undefined;
  }
  const truncated = Math.trunc(efSearch);
  if (truncated < 1) {
    return undefined;
  }
  return Math.min(truncated, 1000);
}

async function runDenseQuery(
  db: Database | Transaction,
  options: DenseSearchOptions,
): Promise<RetrievedChunk[]> {
  const { orgId, scope, queryVector, limit = 40, candidateDocumentIds } = options;

  const vectorLiteral = `[${queryVector.join(',')}]`;
  const distanceSql = sql<number>`${schema.chunks.embedding} <=> ${vectorLiteral}::vector`;
  const similaritySql = sql<number>`(1.0 - (${distanceSql}))`;

  const filters = [eq(schema.chunks.orgId, orgId), isNotNull(schema.chunks.embedding)];

  if (scope.kind === 'document') {
    filters.push(eq(schema.chunks.documentId, scope.documentId));
  } else if (candidateDocumentIds && candidateDocumentIds.length > 0) {
    filters.push(inArray(schema.chunks.documentId, candidateDocumentIds));
  } else if (scope.folderId) {
    // Filter to documents within specified folder
    const folderDocs = db
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(and(eq(schema.documents.orgId, orgId), eq(schema.documents.folderId, scope.folderId)));
    filters.push(inArray(schema.chunks.documentId, folderDocs));
  }

  const rows = await db
    .select({
      id: schema.chunks.id,
      documentId: schema.chunks.documentId,
      ordinal: schema.chunks.ordinal,
      text: schema.chunks.text,
      sectionPath: schema.chunks.sectionPath,
      pages: schema.chunks.pages,
      meta: schema.chunks.meta,
      score: similaritySql,
    })
    .from(schema.chunks)
    .where(and(...filters))
    .orderBy(distanceSql)
    .limit(limit);

  return rows.map((row) => {
    const pages = (row.pages ?? []) as ChunkPage[];
    const firstPage = pages[0]?.page ?? 1;
    const firstBbox = pages[0]?.bbox ?? [0, 0, 0, 0];

    return {
      id: row.id,
      documentId: row.documentId,
      ordinal: row.ordinal,
      text: row.text,
      score: Number(row.score ?? 0),
      sectionPath: row.sectionPath,
      pages,
      meta: row.meta as ChunkMeta | null,
      page: firstPage,
      bbox: firstBbox,
    };
  });
}
