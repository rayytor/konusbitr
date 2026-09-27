import { fuzzyIncludes, type GroundedChunk, normalizeText } from '@konusbitr/ai';
import type { Citation } from '@konusbitr/shared';

/**
 * Making the model's structured output honest.
 *
 * The rule is the same one Phase 10 applies to chat, and for the same reason: a
 * quote that does not appear in the document is a claim we cannot stand behind,
 * so it does not reach the caller. What is different here is the *consequence*.
 * In chat an unverifiable citation is dropped and the sentence survives; in an
 * extraction there is no sentence — the citation is the only evidence for a
 * value — so dropping the citation means dropping the value.
 *
 * That is a deliberately sharp rule, and it is the one that makes `extract`
 * worth using. A field returned with a number in it that came from nowhere is
 * strictly worse than a field returned as `null`: the first is wrong and
 * confident, and somebody will put it in a spreadsheet.
 *
 * ## What this does not check
 *
 * It verifies that the quote is in the document. It does not verify that the
 * quote *supports the value*, and the reason is that the check would have to be
 * "the value appears in the quote" — which is false for most correct
 * extractions. A `number` field is `1284567` from "£1,284,567"; a date field is
 * `2026-04-01` from "1 April 2026"; a boolean is `true` from a sentence
 * containing neither word. A rule strict enough to catch a real quote attached
 * to a wrong value would reject all three.
 *
 * So the quote is returned *beside* the value, in the citation, with its page
 * and its box. A caller who needs to audit a field has the exact sentence it
 * came from and where on the page to find it, which is the strongest guarantee
 * that does not also throw away correct answers.
 */

export type Evidence = {
  schemaPath: string;
  quote: string | null;
  page: number | null;
  chunkId?: string | null;
};

export type VerifiedValue = {
  schemaPath: string;
  citation: Citation;
};

export type UnverifiedValue = {
  schemaPath: string;
  value: unknown;
  quote: string | null;
  page: number | null;
  reason: string;
};

/**
 * Where the evidence is checked against.
 *
 * Two sources, because `extract` reads the document two ways. Under
 * `EXTRACT_WHOLE_DOCUMENT_MAX_PAGES` it reads the whole markdown, and there are
 * no chunks to check against — so `pageText` carries the document's text per
 * page, assembled from the parse artifact's elements. Above it the extractor
 * retrieves, and the chunks themselves are the evidence, exactly as in chat.
 */
export type VerificationSources = {
  chunks: readonly GroundedChunk[];
  /** 1-based page number → the normalized text on that page. */
  pageText: ReadonlyMap<number, string>;
};

/** Address one value inside `{ result: … }` by its `result.a.b[0]` path. */
export function readAtPath(root: unknown, path: string): { found: boolean; value: unknown } {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);

  if (segments[0] !== 'result') return { found: false, value: undefined };

  let node: unknown = { result: root };
  for (const segment of segments) {
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) {
        return { found: false, value: undefined };
      }
      node = node[index];
      continue;
    }
    if (typeof node !== 'object' || node === null || !(segment in node)) {
      return { found: false, value: undefined };
    }
    node = (node as Record<string, unknown>)[segment];
  }

  return { found: true, value: node };
}

/** Remove one value from `{ result: … }`, leaving the structure around it intact. */
export function deleteAtPath(root: Record<string, unknown>, path: string): void {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);

  if (segments[0] !== 'result' || segments.length < 2) return;

  // `root` is the wrapper `{ result: … }`, so the walk starts at index 0 and
  // consumes `result` like any other segment. Starting at 1 would look past the
  // wrapper for a key named after the first *child*, find nothing, and silently
  // leave the unverified value in place.
  let node: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i] as string;
    if (Array.isArray(node)) node = node[Number(segment)];
    else if (typeof node === 'object' && node !== null)
      node = (node as Record<string, unknown>)[segment];
    else return;
  }

  const last = segments[segments.length - 1] as string;
  if (Array.isArray(node)) {
    const index = Number(last);
    // Nulled rather than spliced: removing an element would renumber every
    // index after it, and the evidence for those values addresses them by
    // index. A hole is honest; a shifted array is silently wrong.
    if (Number.isInteger(index) && index >= 0 && index < node.length) node[index] = null;
    return;
  }
  if (typeof node === 'object' && node !== null) {
    (node as Record<string, unknown>)[last] = null;
  }
}

/**
 * Whether a quote is genuinely present in a piece of source text.
 *
 * Exact containment after normalization, and then — **only for a quote with no
 * digits in it** — the same 0.85 fuzzy window chat uses.
 *
 * That carve-out is the single most important line in this file. Fuzzy matching
 * exists to survive hyphenation, ligatures and the noise a recogniser leaves in
 * prose, and at 0.85 it happily accepts `£1,234,567` as a match for
 * `£1,284,567`: one substitution in ten characters scores 0.9. In chat that
 * would be a citation attached to a sentence a reader can check. Here the value
 * *is* the number, so the fuzzy match would launder exactly the failure this
 * endpoint exists to prevent — a model misreading a digit and being entirely
 * certain about it — into a verified field in somebody's spreadsheet. The same
 * reasoning is why the VLM tier reconciles a table cell by cell rather than
 * trusting what the model wrote; see `docs/adr/0007-vlm-tier.md`.
 *
 * A quote with digits therefore has to be verbatim. The normalizer has already
 * stripped soft hyphens and rejoined words broken across a line, so the noise
 * fuzzy matching was introduced for is gone by the time this runs.
 */
function quoteAppearsIn(source: string, normalizedQuote: string, rawQuote: string): boolean {
  if (source.includes(normalizedQuote)) return true;
  if (/\d/.test(rawQuote)) return false;
  return fuzzyIncludes(source, normalizedQuote, 0.85);
}

/**
 * Check one piece of evidence, and return a citation if it stands up.
 *
 * Three things have to be true: the quote is non-empty, the page it names is a
 * page of the document, and the quote actually appears in the text of that page
 * on the terms {@link quoteAppearsIn} sets. Anything else is a rejection with a
 * reason, because "the model made it up" and "the model cited the wrong page"
 * are different problems and an operator watching the rejection rate needs to
 * be able to tell them apart.
 */
function checkQuote(
  evidence: Evidence,
  sources: VerificationSources,
): { ok: true; citation: Citation } | { ok: false; reason: string } {
  const quote = evidence.quote?.trim() ?? '';
  if (!quote) return { ok: false, reason: 'No quote was given for this value.' };

  const normalizedQuote = normalizeText(quote);
  if (!normalizedQuote) return { ok: false, reason: 'The quote is empty after normalization.' };

  // The retrieved-chunk path, when the extractor used one. The named chunk is
  // tried first and then every other retrieved chunk: a model that cited the
  // right passage under the wrong id has still found the right passage, and
  // discarding a correct value over a mistyped identifier would be pedantry.
  if (sources.chunks.length > 0) {
    const named = evidence.chunkId
      ? sources.chunks.find((chunk) => chunk.id === evidence.chunkId)
      : undefined;
    const candidates = named
      ? [named, ...sources.chunks.filter((c) => c !== named)]
      : sources.chunks;

    for (const chunk of candidates) {
      if (!quoteAppearsIn(normalizeText(chunk.text), normalizedQuote, quote)) continue;

      // The page is taken from the chunk that actually contains the quote, not
      // from what the model said: the chunk knows which pages it spans and the
      // model is guessing.
      const page =
        chunk.pages.find((entry) => entry.page === evidence.page)?.page ??
        chunk.pages[0]?.page ??
        evidence.page ??
        1;
      const bbox =
        chunk.pages.find((entry) => entry.page === page)?.bbox ??
        chunk.pages[0]?.bbox ??
        ([0, 0, 0, 0] as [number, number, number, number]);

      return {
        ok: true,
        citation: {
          quote,
          page,
          bbox,
          chunkId: chunk.id,
          ...(chunk.documentId ? { documentId: chunk.documentId } : {}),
          schemaPath: evidence.schemaPath,
        },
      };
    }

    return { ok: false, reason: 'The quote does not appear in any retrieved passage.' };
  }

  // The whole-markdown path. There are no chunks, so the page's own text is the
  // evidence, and a quote with no page cannot be placed at all.
  if (evidence.page === null) {
    return { ok: false, reason: 'No page was given for this value.' };
  }
  const pageText = sources.pageText.get(evidence.page);
  if (pageText === undefined) {
    return { ok: false, reason: `Page ${evidence.page} is not a page of this document.` };
  }
  if (!quoteAppearsIn(pageText, normalizedQuote, quote)) {
    return { ok: false, reason: `The quote does not appear on page ${evidence.page}.` };
  }

  return {
    ok: true,
    citation: {
      quote,
      page: evidence.page,
      // No bounding box on this path, and a zero rectangle rather than an
      // invented one. The whole-markdown reading knows which page a quote is on
      // and genuinely does not know where on it — claiming otherwise would draw
      // a highlight over the wrong words.
      bbox: [0, 0, 0, 0],
      chunkId: '',
      schemaPath: evidence.schemaPath,
    },
  };
}

/**
 * Verify every leaf of an extraction, and strike out what does not hold up.
 *
 * Mutates `result`, which is the point: the returned object is the one the
 * caller receives, and a value whose evidence failed must not be in it.
 */
export function verifyExtraction(
  result: Record<string, unknown>,
  evidence: readonly Evidence[],
  sources: VerificationSources,
): { citations: Citation[]; unverified: UnverifiedValue[] } {
  const citations: Citation[] = [];
  const unverified: UnverifiedValue[] = [];
  const wrapper = { result };
  const seen = new Set<string>();

  for (const entry of evidence) {
    if (seen.has(entry.schemaPath)) continue;
    seen.add(entry.schemaPath);

    const located = readAtPath(result, entry.schemaPath);
    // Evidence for a path that is not in the result is not a failure to report
    // to the caller: there is no value to drop, and saying otherwise would fill
    // `unverified` with the model's bookkeeping mistakes rather than with
    // values the caller nearly received.
    if (!located.found) continue;
    // A null was never a claim, so there is nothing to verify and nothing to
    // drop — `null` is the correct answer for a field the document omits.
    if (located.value === null || located.value === undefined) continue;

    const checked = checkQuote(entry, sources);
    if (checked.ok) {
      citations.push(checked.citation);
      continue;
    }

    unverified.push({
      schemaPath: entry.schemaPath,
      value: located.value,
      quote: entry.quote,
      page: entry.page,
      reason: checked.reason,
    });
    deleteAtPath(wrapper, entry.schemaPath);
  }

  // Anything the model filled in but produced no evidence for at all. Rule 1 of
  // the prompt says every leaf needs an entry; a leaf without one is exactly
  // the invented value this endpoint exists not to return.
  for (const path of leafPaths(result)) {
    if (seen.has(path)) continue;
    const located = readAtPath(result, path);
    if (!located.found || located.value === null || located.value === undefined) continue;

    unverified.push({
      schemaPath: path,
      value: located.value,
      quote: null,
      page: null,
      reason: 'The model gave no quote for this value.',
    });
    deleteAtPath(wrapper, path);
  }

  return { citations, unverified };
}

/** Every leaf position in the result, as `result.a.b[0]` paths. */
export function leafPaths(root: unknown, prefix = 'result'): string[] {
  if (Array.isArray(root)) {
    return root.flatMap((entry, index) => leafPaths(entry, `${prefix}[${index}]`));
  }
  if (typeof root === 'object' && root !== null) {
    return Object.entries(root).flatMap(([key, value]) => leafPaths(value, `${prefix}.${key}`));
  }
  return [prefix];
}
