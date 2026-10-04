import {
  type ParseRequest,
  ParseRequestSchema,
  ParseResponseSchema,
  parseCost,
} from '@konusbitr/shared';
import { loadWebEnv } from '@/lib/env';
import { loadArtifact } from '../artifact';
import { attachDocument } from '../async';
import type { RouteContext } from '../context';
import { assertNotExhausted, charge, recordCacheHit } from '../credits';
import { awaitDocumentReady, resolveInput } from '../input';
import type { RouteImplementation } from '../mount';
import { DOCUMENT_INPUT_ERROR_CODES, type RouteDefinition } from '../registry';

/**
 * `POST /v2/parse` — bytes in, structure out.
 *
 * The endpoint the rest of the API is built on: everything else either takes a
 * `docId` this produced or produces one itself by doing exactly what this does.
 * Which is why the docId cache is the thing to understand about it. A second
 * call with the same bytes and the same settings does no work, enqueues no job,
 * spends no credits and returns in milliseconds — and writes a `cache_hit` row
 * so that "it was free" is a fact in the ledger rather than a claim in a
 * README.
 */

const definition: RouteDefinition = {
  method: 'post',
  path: '/parse',
  operationId: 'parse',
  summary: 'Parse a document into markdown and located elements',
  description: [
    'Accepts exactly one of `file` (multipart), `url` or `docId`.',
    '',
    'Returns the document as markdown plus a `contents` array in which every',
    'element carries its page and its bounding box, in PDF points with the',
    'origin at the top left of the unrotated page. Figures extracted from the',
    'document are listed in `images`.',
    '',
    'A repeat call with the same bytes and the same settings is served from the',
    'parse cache: it returns immediately, costs nothing, and sets `cached`.',
  ].join('\n'),
  scopes: ['parse'],
  body: 'json-or-multipart',
  request: ParseRequestSchema,
  response: ParseResponseSchema,
  async: 'parse',
  errors: DOCUMENT_INPUT_ERROR_CODES,
};

/**
 * How long a synchronous call waits for a parse before giving up on it.
 *
 * Five minutes, which covers the stated budget for a fifty-page text document
 * many times over and still stops well short of the point where an intermediary
 * would drop the connection anyway. Past it the caller is told to use
 * `?async=true` rather than being left holding a socket — and the parse is not
 * cancelled, so the document is ready by the time they ask again.
 */
const SYNC_PARSE_TIMEOUT_MS = 5 * 60 * 1000;

async function run(ctx: RouteContext<ParseRequest>) {
  await assertNotExhausted(ctx.auth.orgId, loadWebEnv());

  const resolved = await resolveInput(ctx.auth, ctx.body as Record<string, unknown>, ctx.file);
  if (ctx.jobId) await attachDocument(ctx.auth, ctx.jobId, resolved.document.id);

  const ready = await awaitDocumentReady(ctx.auth, resolved.document.id, {
    // An async caller is not holding a connection, so it waits as long as the
    // pipeline takes; a synchronous one gets the bounded wait above.
    timeoutMs: ctx.jobId ? Number.POSITIVE_INFINITY : SYNC_PARSE_TIMEOUT_MS,
    requireComplete: true,
  });

  const artifact = await loadArtifact(ctx.auth, ready);

  // Charged after the work, so a parse that failed is never billed — and the
  // page count used is the one the parse actually found rather than the
  // estimate intake made from the file's structure.
  const cost = parseCost(artifact.pageCount, resolved.cached);
  if (resolved.cached) {
    // One row per free call, exactly. A repeated upload was already recorded
    // by intake; a `docId` was not, because it never reached intake.
    if (!resolved.cacheHitRecorded) {
      await recordCacheHit(ctx.auth.orgId, ready.id, { endpoint: 'parse' });
    }
  } else {
    await charge({
      orgId: ctx.auth.orgId,
      amount: cost,
      reason: 'parse',
      refId: ready.id,
      metadata: { pages: artifact.pageCount, quality: resolved.settings.quality },
    });
  }

  return {
    docId: ready.id,
    markdown: artifact.markdown,
    contents: artifact.contents,
    images: artifact.images,
    pageCount: artifact.pageCount,
    cached: resolved.cached,
  };
}

export const parseRoute: RouteImplementation<ParseRequest> = { definition, run };
