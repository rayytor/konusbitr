import type { Database } from '@konusbitr/db';
import * as schema from '@konusbitr/db/schema';
import type { ChunkMeta, ChunkPage } from '@konusbitr/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { dropStopWords } from './stopwords.js';
import type { RetrievedChunk, Scope } from './types.js';

export type SparseSearchOptions = {
  db: Database;
  orgId: string;
  scope: Scope;
  query: string;
  limit?: number;
  candidateDocumentIds?: string[];
};

/**
 * Build the tsquery the sparse leg searches with.
 *
 * `websearch_to_tsquery` is the right parser — it understands quoted phrases and
 * `-exclusion` the way a search box does — but its implicit operator is AND, and
 * the text search configuration here is `simple`, which removes no stop words
 * because the corpus is multilingual. Put together, a question like "What was
 * Licensing revenue in 2023?" becomes
 *
 *     'what' & 'was' & 'licensing' & 'revenue' & 'in' & '2023'
 *
 * and matches no passage at all, because no passage contains every one of those
 * words. That is not a tuning problem: it silently reduced the sparse leg to
 * returning nothing for natural-language questions, which is every question a
 * chat product asks. The eval caught it the first time it ran against real SQL.
 *
 * So the conjunction is rewritten to a disjunction and `ts_rank_cd` does the
 * work it is for — ranking by how many query terms a passage covers and how
 * close together they are — rather than the query acting as a filter that
 * everything fails. Phrase groups (`<->`) survive the rewrite untouched because
 * they contain no `&`.
 *
 * A query carrying a negation keeps its AND form: `!'licensing'` OR'd against
 * the rest would match every passage that merely lacks the excluded word, which
 * is the opposite of what was asked for.
 */
function buildTsquery(query: string) {
  // Stop words come out before the parser sees them, not after: the OR rewrite
  // below is what makes them ruinous, because a query containing "the" then
  // matches every passage in the corpus and `ts_rank_cd` has to score all of
  // them. See `stopwords.ts` for the measurement.
  const parsed = sql`websearch_to_tsquery('simple', ${dropStopWords(query)})`;
  return sql`(
    CASE
      WHEN strpos(${parsed}::text, '!') > 0 THEN ${parsed}
      ELSE replace(${parsed}::text, '&', '|')::tsquery
    END
  )`;
}

/**
 * Perform sparse BM25-style keyword search over the generated tsvector column.
 *
 * Uses `websearch_to_tsquery('simple', query)` with `ts_rank_cd`, filtered by
 * orgId and document/corpus scope. See {@link buildTsquery} for why the parsed
 * query is not used exactly as Postgres returns it.
 */
export async function searchSparse(options: SparseSearchOptions): Promise<RetrievedChunk[]> {
  const { db, orgId, scope, query, limit = 40, candidateDocumentIds } = options;

  if (!query.trim()) {
    return [];
  }

  const cleanQuery = query.trim();
  const tsquery = buildTsquery(cleanQuery);
  const rankSql = sql<number>`ts_rank_cd(${schema.chunks.tsv}, ${tsquery})`;

  const filters = [eq(schema.chunks.orgId, orgId), sql`${schema.chunks.tsv} @@ ${tsquery}`];

  if (scope.kind === 'document') {
    filters.push(eq(schema.chunks.documentId, scope.documentId));
  } else if (candidateDocumentIds && candidateDocumentIds.length > 0) {
    filters.push(inArray(schema.chunks.documentId, candidateDocumentIds));
  } else if (scope.folderId) {
    const folderDocs = db
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(and(eq(schema.documents.orgId, orgId), eq(schema.documents.folderId, scope.folderId)));
    filters.push(inArray(schema.chunks.documentId, folderDocs));
  }

  try {
    const rows = await db
      .select({
        id: schema.chunks.id,
        documentId: schema.chunks.documentId,
        ordinal: schema.chunks.ordinal,
        text: schema.chunks.text,
        sectionPath: schema.chunks.sectionPath,
        pages: schema.chunks.pages,
        meta: schema.chunks.meta,
        score: rankSql,
      })
      .from(schema.chunks)
      .where(and(...filters))
      .orderBy(sql`${rankSql} DESC`)
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
  } catch (error) {
    // Only a malformed tsquery earns the fallback. Catching everything here is
    // how a connection failure or a missing column turned into an empty result
    // set that read as "no matches" — the same way the dense leg used to hide a
    // query it could not run at all.
    if (!isTsquerySyntaxError(error)) {
      throw error;
    }
    return fallbackPlainSearch(options);
  }
}

/**
 * Whether Postgres rejected the *query text*, as opposed to failing the query.
 *
 * `websearch_to_tsquery` is deliberately forgiving, so this is rare — but it is
 * the one failure where retrying with `plainto_tsquery` is the right answer, and
 * the only one that should not reach the caller.
 */
function isTsquerySyntaxError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  // 42601 syntax_error, 42P13 invalid_function_definition, 22P02 invalid_text_representation.
  return code === '42601' || code === '22P02';
}

async function fallbackPlainSearch(options: SparseSearchOptions): Promise<RetrievedChunk[]> {
  const { db, orgId, scope, query, limit = 40, candidateDocumentIds } = options;
  const cleanQuery = query.trim();
  // Same rewrite, same reason: `plainto_tsquery` also ANDs its terms.
  const parsed = sql`plainto_tsquery('simple', ${dropStopWords(cleanQuery)})`;
  const tsquery = sql`replace(${parsed}::text, '&', '|')::tsquery`;
  const rankSql = sql<number>`ts_rank_cd(${schema.chunks.tsv}, ${tsquery})`;

  const filters = [eq(schema.chunks.orgId, orgId), sql`${schema.chunks.tsv} @@ ${tsquery}`];

  if (scope.kind === 'document') {
    filters.push(eq(schema.chunks.documentId, scope.documentId));
  } else if (candidateDocumentIds && candidateDocumentIds.length > 0) {
    filters.push(inArray(schema.chunks.documentId, candidateDocumentIds));
  } else if (scope.folderId) {
    const folderDocs = db
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(and(eq(schema.documents.orgId, orgId), eq(schema.documents.folderId, scope.folderId)));
    filters.push(inArray(schema.chunks.documentId, folderDocs));
  }

  // No try/catch: the fallback is the last resort, and a failure here belongs to
  // the caller rather than becoming an empty list that reads as "no matches".
  const rows = await db
    .select({
      id: schema.chunks.id,
      documentId: schema.chunks.documentId,
      ordinal: schema.chunks.ordinal,
      text: schema.chunks.text,
      sectionPath: schema.chunks.sectionPath,
      pages: schema.chunks.pages,
      meta: schema.chunks.meta,
      score: rankSql,
    })
    .from(schema.chunks)
    .where(and(...filters))
    .orderBy(sql`${rankSql} DESC`)
    .limit(limit);

  return rows.map((row) => {
    const pages = (row.pages ?? []) as ChunkPage[];
    return {
      id: row.id,
      documentId: row.documentId,
      ordinal: row.ordinal,
      text: row.text,
      score: Number(row.score ?? 0),
      sectionPath: row.sectionPath,
      pages,
      meta: row.meta as ChunkMeta | null,
      page: pages[0]?.page ?? 1,
      bbox: pages[0]?.bbox ?? [0, 0, 0, 0],
    };
  });
}
