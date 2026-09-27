import {
  buildContext,
  completeChat,
  type GroundedChunk,
  loadPrompt,
  normalizeText,
} from '@konusbitr/ai';
import { retrieve } from '@konusbitr/retrieval';
import {
  type Citation,
  EXTRACT_WHOLE_DOCUMENT_MAX_PAGES,
  type ParsedElement,
} from '@konusbitr/shared';
import { db } from '@/lib/db';
import { loadWebEnv } from '@/lib/env';
import { ApiError } from '../errors';
import { fieldQuery, type SchemaSummary } from './schema';
import { type Evidence, type UnverifiedValue, verifyExtraction } from './verify';

/**
 * The extractor.
 *
 * Three decisions are worth reading before changing anything here.
 *
 * **Small documents are not decomposed.** Under thirty pages the whole markdown
 * goes into the prompt, and that is simpler *and* better: the model sees the
 * document's own order, its headings and the relationships between its sections
 * rather than eight passages that a similarity search thought looked relevant
 * to the phrase "invoice total". Decomposition exists because a nine-hundred
 * page filing does not fit in a context window, not because it is a better way
 * to read a document.
 *
 * **Above it, retrieval is per field.** One search per top-level field, using
 * the field's own name and description as the query, and the union of what
 * comes back is the context. Searching once for the whole schema returns
 * passages relevant to the schema's average, which is relevant to nothing.
 *
 * **The model's characters are never trusted.** Every leaf value comes back
 * with a verbatim quote, and the quote is checked against the document before
 * the value is returned. See `verify.ts` for why a failed check drops the value
 * rather than merely the citation.
 */

export type ExtractionOutcome = {
  result: Record<string, unknown>;
  citations: Citation[];
  unverified: UnverifiedValue[];
};

/** Chunks retrieved per top-level field. Small, because fields are narrow. */
const CHUNKS_PER_FIELD = 4;

/** Ceiling on the whole-document prompt, in characters. */
const MAX_MARKDOWN_CHARS = 240_000;

/**
 * The document's text, page by page, normalized once.
 *
 * Built from the parse artifact's elements rather than from the markdown,
 * because the markdown has no page boundaries in it — and a verifier that could
 * not say which page a quote was on could not reject a quote that is real but
 * cited three pages away.
 */
export function pageTextIndex(contents: readonly ParsedElement[]): Map<number, string> {
  const byPage = new Map<number, string[]>();
  for (const element of contents) {
    const text = element.text ?? element.markdown ?? '';
    if (!text) continue;
    const existing = byPage.get(element.page);
    if (existing) existing.push(text);
    else byPage.set(element.page, [text]);
  }

  const index = new Map<number, string>();
  for (const [page, parts] of byPage) index.set(page, normalizeText(parts.join('\n')));
  return index;
}

/** Retrieve evidence for each top-level field and merge it, de-duplicated. */
async function decompose(
  orgId: string,
  documentId: string,
  schema: Record<string, unknown>,
  summary: SchemaSummary,
): Promise<GroundedChunk[]> {
  const env = loadWebEnv();
  const properties = (schema.properties ?? {}) as Record<string, unknown>;

  const searches = await Promise.all(
    summary.topLevelFields.map(async (field) => {
      try {
        return await retrieve({
          db: db(),
          orgId,
          scope: { kind: 'document', documentId },
          query: fieldQuery(field, properties[field]),
          topK: CHUNKS_PER_FIELD,
          env,
        });
      } catch (error) {
        // One field's search failing is not the extraction failing: the other
        // fields still have evidence, and the values this one would have
        // produced will simply have no quote and be dropped by the verifier —
        // which is the correct outcome for a field we could find nothing for.
        console.warn('[v2/extract] field retrieval failed', { field, error });
        return [];
      }
    }),
  );

  const merged = new Map<string, GroundedChunk>();
  for (const chunks of searches) {
    for (const chunk of chunks) {
      if (!merged.has(chunk.id)) merged.set(chunk.id, chunk);
    }
  }
  return [...merged.values()];
}

/**
 * Pull the JSON object out of whatever the model actually returned.
 *
 * The prompt asks for bare JSON, and models return it wrapped in a code fence
 * often enough that treating that as a failure would be choosing to be right
 * rather than to work. Anything beyond a fence or surrounding whitespace is a
 * genuine failure and is reported as one.
 */
export function parseModelJson(raw: string): { result: unknown; evidence: Evidence[] } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();

  // A model that wrote a sentence before the object: take from the first brace
  // to the last, which is the whole object whenever there is exactly one.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  const json = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ApiError(
      'model_unavailable',
      'The model did not return a usable JSON object for this schema. Try a smaller schema.',
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ApiError('model_unavailable', 'The model did not return a JSON object.');
  }

  const record = parsed as Record<string, unknown>;
  const rawEvidence = Array.isArray(record.evidence) ? record.evidence : [];

  return {
    // A model that returned the object itself rather than `{ result: … }` has
    // still done the work; unwrapping is cheaper than a retry.
    result: 'result' in record ? record.result : record,
    evidence: rawEvidence
      .filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
      )
      .map((entry) => ({
        schemaPath: String(entry.schemaPath ?? ''),
        quote: typeof entry.quote === 'string' ? entry.quote : null,
        page: Number.isFinite(Number(entry.page)) ? Number(entry.page) : null,
        chunkId: typeof entry.chunkId === 'string' ? entry.chunkId : null,
      }))
      .filter((entry) => entry.schemaPath.startsWith('result')),
  };
}

export async function extractFromDocument(input: {
  orgId: string;
  documentId: string;
  schema: Record<string, unknown>;
  summary: SchemaSummary;
  markdown: string;
  contents: readonly ParsedElement[];
  pageCount: number;
  systemPrompt?: string;
  signal?: AbortSignal;
}): Promise<ExtractionOutcome> {
  const env = loadWebEnv();

  const useWholeDocument =
    input.pageCount > 0 && input.pageCount <= EXTRACT_WHOLE_DOCUMENT_MAX_PAGES;

  const chunks = useWholeDocument
    ? []
    : await decompose(input.orgId, input.documentId, input.schema, input.summary);

  const document = useWholeDocument ? truncateMarkdown(input.markdown) : buildContext(chunks);

  const system = [
    loadPrompt('api.extract.v1'),
    // The caller's own words, fenced and labelled. It is domain context — "this
    // is a Turkish rental contract; amounts are in lira" — and it is placed
    // after our rules rather than before them so that it adds to the task
    // rather than appearing to redefine it.
    input.systemPrompt ? `\n\nCALLER CONTEXT:\n${input.systemPrompt}` : '',
  ].join('');

  let raw: string;
  try {
    raw = await completeChat(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            `SCHEMA:\n${JSON.stringify(input.schema, null, 2)}`,
            '',
            `DOCUMENT:\n${document}`,
          ].join('\n'),
        },
      ],
      // Zero rather than the 0.1 chat uses. There is no prose to be stilted
      // here — every token is either a value copied out of the document or a
      // structural brace, and sampling variety in either is only a way to be
      // wrong occasionally.
      { env, temperature: 0, signal: input.signal },
    );
  } catch (error) {
    throw new ApiError('model_unavailable', 'The chat model could not be reached.', {
      detail: error instanceof Error ? error.message : undefined,
    });
  }

  const { result, evidence } = parseModelJson(raw);
  const object = (typeof result === 'object' && result !== null ? result : {}) as Record<
    string,
    unknown
  >;

  const { citations, unverified } = verifyExtraction(object, evidence, {
    chunks,
    pageText: pageTextIndex(input.contents),
  });

  return { result: object, citations, unverified };
}

/**
 * Cut an oversized document rather than letting the provider refuse it.
 *
 * A visible marker, because a silent truncation is how an extraction comes back
 * confidently missing the second half of a contract. The threshold is generous:
 * this path only runs for documents already known to be under thirty pages, so
 * reaching it means a page of unusually dense text rather than a long document.
 */
function truncateMarkdown(markdown: string): string {
  if (markdown.length <= MAX_MARKDOWN_CHARS) return markdown;
  return `${markdown.slice(0, MAX_MARKDOWN_CHARS)}\n\n[document truncated for extraction]`;
}
