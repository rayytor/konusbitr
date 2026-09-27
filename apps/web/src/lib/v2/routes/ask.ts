import { buildContext, completeChat, loadPrompt, verifyCitations } from '@konusbitr/ai';
import { retrieve } from '@konusbitr/retrieval';
import {
  type AskRequest,
  AskRequestSchema,
  AskResponseSchema,
  askCost,
  isAnswerableDocumentStatus,
} from '@konusbitr/shared';
import { db } from '@/lib/db';
import { loadWebEnv } from '@/lib/env';
import { attachDocument } from '../async';
import type { RouteContext } from '../context';
import { assertNotExhausted, charge } from '../credits';
import { ApiError } from '../errors';
import { awaitDocumentReady, resolveInput } from '../input';
import type { RouteImplementation } from '../mount';
import { DOCUMENT_INPUT_ERROR_CODES, type RouteDefinition } from '../registry';

/**
 * `POST /v2/ask` — one question, one grounded answer, verified citations.
 *
 * The same retrieval and the same verification the product's chat pane uses,
 * with the conversation taken out: no history, no rewriting, no persistence,
 * one call in and one answer out. That is what an API caller wants, and keeping
 * it on the same machinery is what stops the two surfaces drifting into
 * answering the same question differently.
 *
 * Every citation is checked mechanically against the chunk it claims to come
 * from before it is returned, and an unverifiable one is dropped rather than
 * shipped. A caller who gets an answer with no citations is being told
 * something true about our confidence in it.
 */

const definition: RouteDefinition = {
  method: 'post',
  path: '/ask',
  operationId: 'ask',
  summary: 'Ask a question about a document and get a cited answer',
  description: [
    'Accepts exactly one of `file` (multipart), `url` or `docId`, plus a',
    '`question`. Pass `corpus: true` with no document to search every ready',
    'document in the organization.',
    '',
    'Every claim in the answer carries a citation, and every citation is',
    'verified against the parse result for the page it cites before the',
    'response is returned. Citations that cannot be verified are dropped — so',
    'an answer with no citations means nothing in the document supported it.',
  ].join('\n'),
  scopes: ['ask'],
  body: 'json-or-multipart',
  request: AskRequestSchema,
  response: AskResponseSchema,
  async: 'ask',
  errors: [...DOCUMENT_INPUT_ERROR_CODES, 'model_unavailable'],
};

/** How long a synchronous `ask` waits for a document that is still parsing. */
const SYNC_WAIT_MS = 5 * 60 * 1000;

/**
 * The answer a document does not support.
 *
 * Matched against the prompt's own refusal sentence so that a refusal is
 * returned as a refusal rather than as an answer with zero citations, which a
 * client cannot tell apart from a verification failure.
 */
const REFUSAL = 'I cannot find the answer to this question in the provided document.';

export async function answerQuestion(input: {
  orgId: string;
  question: string;
  language?: string;
  scope: { kind: 'document'; documentId: string } | { kind: 'corpus' };
  signal?: AbortSignal;
}): Promise<{ answer: string; citations: ReturnType<typeof verifyCitations>['verified'] }> {
  const env = loadWebEnv();

  const failures: { leg: string; error: unknown }[] = [];
  const chunks = await retrieve({
    db: db(),
    orgId: input.orgId,
    scope: input.scope,
    query: input.question,
    env,
    onLegError: (leg, error) => failures.push({ leg, error }),
  });

  if (failures.length > 0) {
    // Reported, not swallowed. A leg that *throws* is a bug, and a retrieval
    // that quietly became keyword-only still looks healthy from the outside —
    // which is exactly how it went unnoticed for a phase once before.
    console.warn('[v2/ask] retrieval leg failed', {
      orgId: input.orgId,
      legs: failures.map((failure) => failure.leg),
    });
  }

  if (chunks.length === 0) {
    return { answer: REFUSAL, citations: [] };
  }

  const language = input.language
    ? `\n\nANSWER LANGUAGE: ${input.language}. Write the prose of the answer in this language. Do not translate the quotes in the citations block.`
    : '';

  let raw: string;
  try {
    raw = await completeChat(
      [
        { role: 'system', content: loadPrompt('api.ask.v1') + language },
        {
          role: 'user',
          content: `DOCUMENT CONTEXT:\n${buildContext(chunks)}\n\nQUESTION: ${input.question}`,
        },
      ],
      { env, temperature: 0.1, signal: input.signal },
    );
  } catch (error) {
    throw new ApiError(
      'model_unavailable',
      'The chat model could not be reached. Try again shortly.',
      { detail: error instanceof Error ? error.message : undefined },
    );
  }

  const { verified, rejected, cleanAnswer } = verifyCitations(raw, chunks);
  if (rejected.length > 0) {
    console.warn(`[v2/ask] dropped ${rejected.length} unverifiable citation(s)`, {
      orgId: input.orgId,
      reasons: rejected.map((entry) => entry.reason),
    });
  }

  return { answer: cleanAnswer.trim(), citations: verified };
}

async function run(ctx: RouteContext<AskRequest>) {
  const body = ctx.body;
  const env = loadWebEnv();
  await assertNotExhausted(ctx.auth.orgId, env);

  // Corpus scope is the one shape with no document at all, so it is settled
  // before input resolution rather than inside it: `resolveInput` exists to
  // produce a document, and here there is deliberately not one.
  if (body.corpus === true) {
    if (body.docId || body.url || ctx.file) {
      throw new ApiError(
        'input_conflict',
        'corpus: true asks across every document, so it cannot be combined with file, url or docId.',
      );
    }

    const answered = await answerQuestion({
      orgId: ctx.auth.orgId,
      question: body.question,
      language: body.language,
      scope: { kind: 'corpus' },
      signal: ctx.request.signal,
    });

    await charge({
      orgId: ctx.auth.orgId,
      amount: askCost(null, { parseWasCached: true }),
      reason: 'ask',
      refId: null,
      metadata: { scope: 'corpus', citations: answered.citations.length },
    });

    return { ...answered, docId: null };
  }

  const resolved = await resolveInput(ctx.auth, body as Record<string, unknown>, ctx.file);
  if (ctx.jobId) await attachDocument(ctx.auth, ctx.jobId, resolved.document.id);

  // `partially_ready` is usable and is deliberately not waited past: Phase 12.4
  // made the first batch of a long document answerable while the rest is still
  // being read, and an API that waited for the whole thing would be throwing
  // that away.
  const ready = isAnswerableDocumentStatus(resolved.document.status)
    ? resolved.document
    : await awaitDocumentReady(ctx.auth, resolved.document.id, {
        timeoutMs: ctx.jobId ? Number.POSITIVE_INFINITY : SYNC_WAIT_MS,
      });

  const answered = await answerQuestion({
    orgId: ctx.auth.orgId,
    question: body.question,
    language: body.language,
    scope: { kind: 'document', documentId: ready.id },
    signal: ctx.request.signal,
  });

  await charge({
    orgId: ctx.auth.orgId,
    amount: askCost(ready.pageCount, { parseWasCached: resolved.cached }),
    reason: 'ask',
    refId: ready.id,
    metadata: { citations: answered.citations.length },
  });

  return { ...answered, docId: ready.id };
}

export const askRoute: RouteImplementation<AskRequest> = { definition, run };
