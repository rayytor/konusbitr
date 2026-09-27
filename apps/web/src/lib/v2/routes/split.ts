import { scopedDb } from '@konusbitr/db';
import {
  type SplitRange,
  type SplitRequest,
  SplitRequestSchema,
  SplitResponseSchema,
  splitCost,
} from '@konusbitr/shared';
import { db } from '@/lib/db';
import { loadWebEnv } from '@/lib/env';
import { enqueueJob } from '@/lib/ingest/queue';
import { loadArtifact } from '../artifact';
import { attachDocument } from '../async';
import type { RouteContext } from '../context';
import { assertNotExhausted, charge } from '../credits';
import { ApiError } from '../errors';
import { awaitDocumentReady, resolveInput } from '../input';
import type { RouteImplementation } from '../mount';
import { DOCUMENT_INPUT_ERROR_CODES, type RouteDefinition } from '../registry';
import { explicitRanges, semanticRanges } from '../split/ranges';

/**
 * `POST /v2/split` — one document in, several real documents out.
 *
 * "Real" is the load-bearing word. Each output is a document row with its own
 * `docId`, its own bytes in storage and its own index, so it can be passed
 * straight back to `ask` or `extract` — which is the whole point of splitting a
 * four-hundred-page filing into its exhibits.
 *
 * The cut happens in the Python worker, because that is where a PDF can be
 * opened and another one written. What happens here is the *decision*: the page
 * ranges, whether they came from the caller or from the document's own section
 * tree, and the names. The worker receives a list of ranges and never sees a
 * request body.
 */

const definition: RouteDefinition = {
  method: 'post',
  path: '/split',
  operationId: 'split',
  summary: 'Split a document into separate documents',
  description: [
    'Accepts exactly one of `file` (multipart), `url` or `docId`, plus either',
    '`ranges` or `mode: "semantic"`.',
    '',
    '`ranges` takes `"1-4"`, `"7"`, or `{ start, end, name }`; pages are 1-based',
    'and both ends are inclusive.',
    '',
    '`mode: "semantic"` cuts at the parse\'s own section tree and names each',
    'output after the heading it begins at. `level` chooses the heading depth,',
    'default 1. Pages before the first heading become `front-matter.pdf`.',
    '',
    'Each output is a full document with its own `docId`, ready to pass to',
    '`ask` or `extract`. Where the parent has a finished parse, each output',
    'inherits the pages it covers rather than being read again.',
  ].join('\n'),
  scopes: ['split'],
  body: 'json-or-multipart',
  request: SplitRequestSchema,
  response: SplitResponseSchema,
  async: 'split',
  errors: [...DOCUMENT_INPUT_ERROR_CODES, 'invalid_ranges'],
};

const SYNC_WAIT_MS = 5 * 60 * 1000;

/** How long a synchronous caller waits for the worker to finish cutting. */
const SPLIT_TIMEOUT_MS = 10 * 60 * 1000;

async function run(ctx: RouteContext<SplitRequest>) {
  const env = loadWebEnv();
  await assertNotExhausted(ctx.auth.orgId, env);

  const body = ctx.body;
  const mode = body.mode ?? (body.ranges ? 'ranges' : 'semantic');

  if (body.ranges && body.mode === 'semantic') {
    throw new ApiError(
      'invalid_request',
      'Give either ranges or mode: "semantic"; a semantic split chooses its own ranges.',
    );
  }
  if (mode === 'ranges' && !body.ranges) {
    throw new ApiError('invalid_request', 'ranges is required unless mode is "semantic".');
  }

  const resolved = await resolveInput(ctx.auth, body as Record<string, unknown>, ctx.file);
  if (ctx.jobId) await attachDocument(ctx.auth, ctx.jobId, resolved.document.id);

  const ready = await awaitDocumentReady(ctx.auth, resolved.document.id, {
    timeoutMs: ctx.jobId ? Number.POSITIVE_INFINITY : SYNC_WAIT_MS,
    requireComplete: true,
  });

  const artifact = await loadArtifact(ctx.auth, ready);
  const pageCount = artifact.pageCount || ready.pageCount || 0;

  const ranges: SplitRange[] =
    mode === 'semantic'
      ? semanticRanges(artifact.contents, pageCount, body.level ?? 1)
      : explicitRanges(body.ranges ?? [], pageCount);

  const scoped = scopedDb(db(), ctx.auth.orgId);
  const job = await scoped.createJob({
    documentId: ready.id,
    type: 'split',
    payload: { ranges, mode, storageKey: ready.storageKey },
  });
  if (!job) throw new ApiError('internal', 'The split job could not be recorded.');

  await enqueueJob('split', {
    jobId: job.id,
    orgId: ctx.auth.orgId,
    documentId: ready.id,
    storageKey: ready.storageKey,
    contentHash: ready.contentHash,
    settings: resolved.settings,
    // The parent has a finished artifact by construction — `requireComplete`
    // above waited for it — so every output inherits its pages rather than
    // being read a second time.
    split: { ranges, inheritParse: true },
  });

  const outputs = await awaitSplitResult(ctx.auth.orgId, job.id, {
    timeoutMs: ctx.jobId ? Number.POSITIVE_INFINITY : SPLIT_TIMEOUT_MS,
  });

  await charge({
    orgId: ctx.auth.orgId,
    amount: splitCost(pageCount, { parseWasCached: resolved.cached }),
    reason: 'split',
    refId: ready.id,
    metadata: { mode, outputs: outputs.length },
  });

  return { docId: ready.id, documents: outputs };
}

type SplitOutput = { docId: string; name: string; pages: number[] };

/**
 * Wait for the worker to report what it cut.
 *
 * The worker writes its answer to `jobs.result`, which is the durable record —
 * so this poll is a convenience for a caller who is waiting, not the mechanism.
 * An async caller's job row carries the same list once it lands.
 */
async function awaitSplitResult(
  orgId: string,
  jobId: string,
  options: { timeoutMs: number },
): Promise<SplitOutput[]> {
  const scoped = scopedDb(db(), orgId);
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    const row = await scoped.jobById(jobId);

    if (row?.status === 'succeeded') {
      const documents = (row.result as { documents?: SplitOutput[] } | null)?.documents;
      return Array.isArray(documents) ? documents : [];
    }
    if (row?.status === 'failed') {
      throw new ApiError(
        'invalid_document',
        row.error ?? 'That document could not be split.',
        row.errorCode ? { errorCode: row.errorCode } : undefined,
      );
    }

    if (Date.now() >= deadline) {
      throw new ApiError(
        'document_not_ready',
        'The split is still running. Retry with ?async=true, or poll GET /v2/jobs/:jobId.',
        { jobId },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export const splitRoute: RouteImplementation<SplitRequest> = { definition, run };
