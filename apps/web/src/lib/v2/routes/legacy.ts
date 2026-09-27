import {
  askCost,
  type ChatWithAllPdfsRequest,
  ChatWithAllPdfsRequestSchema,
  type ChatWithPdfRequest,
  ChatWithPdfRequestSchema,
  ChatWithPdfResponseSchema,
  isAnswerableDocumentStatus,
} from '@konusbitr/shared';
import { loadWebEnv } from '@/lib/env';
import type { RouteContext } from '../context';
import { assertNotExhausted, charge } from '../credits';
import { ApiError } from '../errors';
import { awaitDocumentReady, resolveInput } from '../input';
import type { RouteImplementation } from '../mount';
import { DOCUMENT_INPUT_ERROR_CODES, type RouteDefinition } from '../registry';
import { answerQuestion } from './ask';

/**
 * The legacy `/v1` surface, kept wire-compatible on purpose.
 *
 * These two endpoints exist so that an integration written against PDF.ai keeps
 * working when its base URL changes, and nothing more. They are a thin
 * translation over the same machinery `/v2/ask` uses: upstream's field names in
 * — `prompt` as well as `question` — and upstream's field names out, `content`
 * rather than `answer` and `references` rather than `citations`.
 *
 * A `reference` is upstream's shape plus three keys it does not have: the
 * quote, the document id and the bounding box. Adding rather than replacing is
 * what keeps it compatible — a client that reads only `page` sees exactly the
 * response it expects, and one that reads the rest gets a citation it can draw
 * on a page. New code should use `/v2/ask`.
 */

const chatWithPdfDefinition: RouteDefinition = {
  method: 'post',
  path: '/chat-with-pdf',
  operationId: 'chatWithPdf',
  summary: 'Ask a question about one document (legacy, PDF.ai-compatible)',
  description: [
    'Compatibility shim over `POST /v2/ask`. Accepts `url` or `docId` plus',
    '`question` (or its older spelling `prompt`), and returns `content` and',
    '`references`.',
    '',
    "Each reference carries upstream's `page` plus the verbatim `quote`, the",
    '`docId` and the `bbox` — additive, so an existing client is unaffected.',
    '',
    'Prefer `/v2/ask` for new integrations: it returns the same answer with',
    'richer citations and supports `?async=true`.',
  ].join('\n'),
  scopes: ['ask'],
  body: 'json',
  request: ChatWithPdfRequestSchema,
  response: ChatWithPdfResponseSchema,
  errors: [...DOCUMENT_INPUT_ERROR_CODES, 'model_unavailable'],
};

const chatWithAllPdfsDefinition: RouteDefinition = {
  method: 'post',
  path: '/chat-with-all-pdfs',
  operationId: 'chatWithAllPdfs',
  summary: 'Ask a question across every document (legacy, PDF.ai-compatible)',
  description: [
    'Compatibility shim over `POST /v2/ask` with `corpus: true`. Searches every',
    'ready document in the organization and returns `content` and `references`,',
    'each reference naming the `docId` it came from.',
    '',
    'Prefer `/v2/ask` with `corpus: true` for new integrations.',
  ].join('\n'),
  scopes: ['ask'],
  body: 'json',
  request: ChatWithAllPdfsRequestSchema,
  response: ChatWithPdfResponseSchema,
  errors: ['invalid_request', 'invalid_json', 'model_unavailable'],
};

/** `question`, or upstream's older `prompt`. Exactly one is required. */
function questionOf(body: { question?: string; prompt?: string }): string {
  const question = body.question ?? body.prompt;
  if (!question) {
    throw new ApiError('invalid_request', 'A question is required.', {
      expected: ['question', 'prompt'],
    });
  }
  return question;
}

type Answered = Awaited<ReturnType<typeof answerQuestion>>;

/** Our citations in upstream's shape, with ours added alongside. */
function toReferences(answered: Answered) {
  return answered.citations.map((citation) => ({
    page: citation.page,
    quote: citation.quote,
    docId: citation.documentId ?? null,
    bbox: citation.bbox,
  }));
}

const SYNC_WAIT_MS = 5 * 60 * 1000;

async function chatWithPdf(ctx: RouteContext<ChatWithPdfRequest>) {
  const env = loadWebEnv();
  await assertNotExhausted(ctx.auth.orgId, env);

  const question = questionOf(ctx.body);
  const resolved = await resolveInput(ctx.auth, ctx.body as Record<string, unknown>, null);

  const ready = isAnswerableDocumentStatus(resolved.document.status)
    ? resolved.document
    : await awaitDocumentReady(ctx.auth, resolved.document.id, { timeoutMs: SYNC_WAIT_MS });

  const answered = await answerQuestion({
    orgId: ctx.auth.orgId,
    question,
    language: ctx.body.language,
    scope: { kind: 'document', documentId: ready.id },
    signal: ctx.request.signal,
  });

  await charge({
    orgId: ctx.auth.orgId,
    amount: askCost(ready.pageCount, { parseWasCached: resolved.cached }),
    reason: 'ask',
    refId: ready.id,
    metadata: { endpoint: 'v1/chat-with-pdf' },
  });

  return { content: answered.answer, references: toReferences(answered) };
}

async function chatWithAllPdfs(ctx: RouteContext<ChatWithAllPdfsRequest>) {
  const env = loadWebEnv();
  await assertNotExhausted(ctx.auth.orgId, env);

  const question = questionOf(ctx.body);
  const answered = await answerQuestion({
    orgId: ctx.auth.orgId,
    question,
    language: ctx.body.language,
    scope: { kind: 'corpus' },
    signal: ctx.request.signal,
  });

  // `docIds` narrows the answer rather than the search. Retrieval's corpus
  // scope filters by folder, not by an arbitrary id list, and adding a variadic
  // filter to the hot path of every corpus query to serve a legacy shim would
  // be the wrong place to pay for it. Filtering the citations is honest as far
  // as it goes and is stated in the docs; a caller who needs a real restriction
  // should ask per document.
  const references = toReferences(answered).filter(
    (reference) =>
      !ctx.body.docIds ||
      ctx.body.docIds.length === 0 ||
      (reference.docId !== null && ctx.body.docIds.includes(reference.docId)),
  );

  await charge({
    orgId: ctx.auth.orgId,
    amount: askCost(null, { parseWasCached: true }),
    reason: 'ask',
    refId: null,
    metadata: { endpoint: 'v1/chat-with-all-pdfs' },
  });

  return { content: answered.answer, references };
}

export const chatWithPdfRoute: RouteImplementation<ChatWithPdfRequest> = {
  definition: chatWithPdfDefinition,
  run: chatWithPdf,
};

export const chatWithAllPdfsRoute: RouteImplementation<ChatWithAllPdfsRequest> = {
  definition: chatWithAllPdfsDefinition,
  run: chatWithAllPdfs,
};
