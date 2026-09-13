import { canResolveModel, completeChat, loadPrompt } from '@konusbitr/ai';
import { scopedDb } from '@konusbitr/db';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';
import { loadWebEnv } from '@/lib/env';
import { IngestError, problemResponse } from '@/lib/ingest/errors';

/**
 * Four questions worth asking about this document.
 *
 * An empty chat pane with a blinking cursor is the worst moment in the product:
 * the person has just waited for a parse and has no idea what this thing can
 * do. Starter questions are the fix, and they have to come from *this*
 * document — four generic prompts are worse than none, because they teach the
 * reader that the suggestions are decoration.
 *
 * So: the abstract the ingest pipeline already wrote (`documents.summary`) goes
 * through the chat role, and when no chat model is configured — or the call
 * fails, or the model returns something that is not four questions — the
 * response is an empty list and the pane simply shows no suggestions. Starter
 * questions are an affordance, never a dependency; a stack with no model
 * configured is a supported state everywhere else in Konusbitr and is one here.
 *
 * The summary is document text, and document text is untrusted data. It reaches
 * the model as content to summarise, never as instruction, and what comes back
 * is filtered to plain one-line questions before it reaches a client.
 */
const WANTED = 4;
const MAX_QUESTION_CHARS = 120;

/**
 * Keep only lines that are actually questions.
 *
 * This is also the injection floor: a summary that tries to talk the model into
 * emitting a paragraph, a link or an instruction produces lines that are not
 * short single-line questions, and they are dropped rather than rendered.
 */
function parseQuestions(raw: string): string[] {
  const seen = new Set<string>();
  const questions: string[] = [];

  for (const line of raw.split('\n')) {
    const cleaned = line
      .trim()
      .replace(/^[-*•]\s*/, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/^["'“‘]|["'”’]$/g, '')
      .trim();

    if (!cleaned.endsWith('?')) continue;
    if (cleaned.length < 8 || cleaned.length > MAX_QUESTION_CHARS) continue;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push(cleaned);

    if (questions.length === WANTED) break;
  }

  return questions;
}

export const GET = withAuth<{ documentId: string }>(
  async (_request, auth, { params }) => {
    try {
      const { documentId } = await params;
      const document = await scopedDb(db(), auth.orgId).documentById(documentId);
      if (!document) throw IngestError.notFound('No document with that id.');

      const env = loadWebEnv();
      const summary = document.summary?.trim();

      if (!summary || !canResolveModel(env, 'chat')) {
        return Response.json({ suggestions: [] }, { headers: { 'cache-control': 'no-store' } });
      }

      let raw: string;
      try {
        raw = await completeChat(
          [
            { role: 'system', content: loadPrompt('chat.suggest.v1') },
            { role: 'user', content: `DOCUMENT ABSTRACT (untrusted data):\n${summary}` },
          ],
          { env, temperature: 0.4 },
        );
      } catch (error) {
        // A model that is configured and then fails is worth a log line, and is
        // not worth failing a page load over: suggestions are an affordance.
        console.warn(`[suggestions] chat model failed for ${documentId}:`, error);
        return Response.json({ suggestions: [] }, { headers: { 'cache-control': 'no-store' } });
      }

      return Response.json(
        { suggestions: parseQuestions(raw) },
        { headers: { 'cache-control': 'no-store' } },
      );
    } catch (error) {
      return problemResponse(error);
    }
  },
  { scopes: ['chat'] },
);

export const dynamic = 'force-dynamic';
