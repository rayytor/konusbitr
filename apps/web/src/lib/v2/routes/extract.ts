import { scopedDb } from '@konusbitr/db';
import {
  type ExtractRequest,
  ExtractRequestSchema,
  ExtractResponseSchema,
  extractCost,
} from '@konusbitr/shared';
import { db } from '@/lib/db';
import { loadWebEnv } from '@/lib/env';
import { loadArtifact } from '../artifact';
import { attachDocument } from '../async';
import type { RouteContext } from '../context';
import { assertNotExhausted, charge } from '../credits';
import { extractFromDocument } from '../extract/engine';
import { validateExtractionSchema } from '../extract/schema';
import { awaitDocumentReady, resolveInput } from '../input';
import type { RouteImplementation } from '../mount';
import { DOCUMENT_INPUT_ERROR_CODES, type RouteDefinition } from '../registry';

/**
 * `POST /v2/extract` — a JSON Schema in, a filled-in object out.
 *
 * The endpoint people integrate against. Its value is not that it produces
 * structured data — any model call does that — but that every value in the
 * object it returns has been checked against the document it came from. A field
 * whose supporting quote is not in the source is returned as `null` and listed
 * in `unverified`, where a caller can see it, rather than silently included.
 *
 * That is the difference between a tool you can put in a pipeline and one you
 * have to read the output of.
 */

const definition: RouteDefinition = {
  method: 'post',
  path: '/extract',
  operationId: 'extract',
  summary: 'Extract structured data from a document against a JSON Schema',
  description: [
    'Accepts exactly one of `file` (multipart), `url` or `docId`, plus a',
    '`schema` describing the object to produce.',
    '',
    'Every leaf value is returned with a citation carrying the verbatim quote,',
    'the page and the `schemaPath` of the value it supports. Quotes are checked',
    'against the parse result before the response is built: a value whose quote',
    'cannot be found is set to `null` and listed in `unverified` with the',
    'reason, rather than returned as though it were in the document.',
    '',
    'Write a `description` on each schema property. It is used as the retrieval',
    'query for that field on documents too large to read whole, and it is the',
    'cheapest way to improve an extraction.',
  ].join('\n'),
  scopes: ['extract'],
  body: 'json-or-multipart',
  request: ExtractRequestSchema,
  response: ExtractResponseSchema,
  async: 'extract',
  errors: [...DOCUMENT_INPUT_ERROR_CODES, 'invalid_schema', 'model_unavailable'],
};

const SYNC_WAIT_MS = 5 * 60 * 1000;

async function run(ctx: RouteContext<ExtractRequest>) {
  const env = loadWebEnv();
  await assertNotExhausted(ctx.auth.orgId, env);

  // Before anything is uploaded or retrieved: the schema decides how much work
  // this request makes, so an unusable one should cost nothing to refuse.
  const summary = validateExtractionSchema(ctx.body.schema);

  const resolved = await resolveInput(ctx.auth, ctx.body as Record<string, unknown>, ctx.file);
  if (ctx.jobId) await attachDocument(ctx.auth, ctx.jobId, resolved.document.id);

  const ready = await awaitDocumentReady(ctx.auth, resolved.document.id, {
    timeoutMs: ctx.jobId ? Number.POSITIVE_INFINITY : SYNC_WAIT_MS,
    requireComplete: true,
  });

  const artifact = await loadArtifact(ctx.auth, ready);

  const outcome = await extractFromDocument({
    orgId: ctx.auth.orgId,
    documentId: ready.id,
    schema: ctx.body.schema,
    summary,
    markdown: artifact.markdown,
    contents: artifact.contents,
    pageCount: artifact.pageCount,
    systemPrompt: ctx.body.system_prompt,
    signal: ctx.request.signal,
  });

  // Kept, because an extraction is a thing a caller comes back to. The row
  // predates this phase — Phase 03 created `extractions` for exactly this — and
  // storing the schema alongside the result is what makes an old extraction
  // interpretable a year later.
  const extraction = await scopedDb(db(), ctx.auth.orgId).createExtraction({
    documentId: ready.id,
    schema: ctx.body.schema,
    result: outcome.result,
    citations: outcome.citations as unknown as Record<string, unknown>[],
  });

  await charge({
    orgId: ctx.auth.orgId,
    amount: extractCost(artifact.pageCount, summary.topLevelFields.length, {
      parseWasCached: resolved.cached,
    }),
    reason: 'extract',
    refId: extraction.id,
    metadata: {
      documentId: ready.id,
      pages: artifact.pageCount,
      fields: summary.topLevelFields.length,
      verified: outcome.citations.length,
      unverified: outcome.unverified.length,
    },
  });

  return {
    docId: ready.id,
    result: outcome.result,
    citations: outcome.citations,
    unverified: outcome.unverified,
  };
}

export const extractRoute: RouteImplementation<ExtractRequest> = { definition, run };
