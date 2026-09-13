import type { BoundingBox, ChunkPage, Citation, RejectedCitation } from '@konusbitr/shared';

export type GroundedChunk = {
  id: string;
  documentId?: string;
  ordinal?: number;
  score?: number;
  text: string;
  pages: ChunkPage[];
  page?: number;
  bbox?: BoundingBox;
  sectionPath?: string | null;
};

export type RawCitation = {
  chunkId: string;
  page: number;
  quote: string;
  documentId?: string;
};

export type CitationVerificationResult = {
  verified: Citation[];
  rejected: RejectedCitation[];
  cleanAnswer: string;
};

/**
 * Normalize whitespace, unicode, punctuation, and hyphenation noise.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, '') // soft hyphen, zero-width spaces
    .replace(/(\w+)-\s*\n\s*(\w+)/g, '$1$2') // hyphenation split across lines
    .replace(/[\u2018\u2019]/g, "'") // curly single quotes
    .replace(/[\u201C\u201D]/g, '"') // curly double quotes
    .replace(/[\u2013\u2014]/g, '-') // en/em dashes
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Compute Levenshtein distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Swap to ensure a is shorter
  if (a.length > b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  let row = Array.from({ length: a.length + 1 }, (_, i) => i);

  for (let j = 1; j <= b.length; j++) {
    const nextRow = [j];
    const bChar = b[j - 1];

    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === bChar ? 0 : 1;
      const prevRow = row[i] ?? 0;
      const prevCol = nextRow[i - 1] ?? 0;
      const diag = row[i - 1] ?? 0;
      nextRow[i] = Math.min(
        prevRow + 1, // deletion
        prevCol + 1, // insertion
        diag + cost, // substitution
      );
    }
    row = nextRow;
  }

  return row[a.length] ?? 0;
}

/**
 * Compute similarity score between 0.0 and 1.0.
 */
export function stringSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(a, b);
  return 1.0 - dist / maxLen;
}

/**
 * Fuzzy check if target appears in source using a sliding window.
 * Returns true if any window has similarity >= threshold (default 0.85).
 */
export function fuzzyIncludes(source: string, target: string, threshold = 0.85): boolean {
  if (!source || !target) return false;
  if (source.includes(target)) return true;

  const targetWords = target.split(' ');
  const sourceWords = source.split(' ');

  if (targetWords.length > sourceWords.length) {
    return stringSimilarity(source, target) >= threshold;
  }

  const windowLen = targetWords.length;
  // Check windows of target length (+/- 2 words for variations)
  for (let delta = -2; delta <= 2; delta++) {
    const curLen = windowLen + delta;
    if (curLen <= 0 || curLen > sourceWords.length) continue;

    for (let i = 0; i <= sourceWords.length - curLen; i++) {
      const window = sourceWords.slice(i, i + curLen).join(' ');
      if (stringSimilarity(window, target) >= threshold) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Parse structured citations block `<citations>[...]</citations>` from model output.
 */
export function parseStructuredCitations(text: string): RawCitation[] {
  const match = text.match(/<citations>([\s\S]*?)<\/citations>/i);
  if (!match?.[1]) return [];

  try {
    const raw = JSON.parse(match[1].trim()) as unknown;
    if (!Array.isArray(raw)) return [];

    const citations: RawCitation[] = [];
    for (const item of raw) {
      if (
        typeof item === 'object' &&
        item !== null &&
        'chunkId' in item &&
        'page' in item &&
        'quote' in item
      ) {
        citations.push({
          chunkId: String(item.chunkId),
          page: Number(item.page),
          quote: String(item.quote).trim(),
          documentId: item.documentId ? String(item.documentId) : undefined,
        });
      }
    }
    return citations;
  } catch {
    return [];
  }
}

/**
 * Parse inline `[[chunk_id, page]]` markers from model output.
 */
export function parseInlineCitationMarkers(text: string): Array<{
  chunkId: string;
  page: number;
  index: number;
}> {
  const matches = text.matchAll(/\[\[([a-zA-Z0-9_-]+),\s*(?:p\.?\s*)?(\d+)\]\]/g);
  const markers: Array<{ chunkId: string; page: number; index: number }> = [];

  for (const m of matches) {
    if (m[1] && m[2] && m.index !== undefined) {
      markers.push({
        chunkId: m[1],
        page: Number.parseInt(m[2], 10),
        index: m.index,
      });
    }
  }

  return markers;
}

/**
 * Remove the `<citations>...</citations>` block from response text.
 */
export function removeCitationsBlock(text: string): string {
  return text.replace(/<citations>[\s\S]*?<\/citations>/gi, '').trim();
}

/**
 * Fallback quote extraction: find the sentence in the chunk that best matches
 * the sentence preceding the inline marker in the model output.
 */
export function findBestMatchingQuote(claimSentence: string, chunkText: string): string | null {
  if (!claimSentence.trim() || !chunkText.trim()) return null;

  // Split chunk text into candidate sentences
  const chunkSentences = chunkText
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  if (chunkSentences.length === 0) return null;

  const normClaim = normalizeText(claimSentence);
  let bestSentence: string | null = null;
  let bestScore = 0;

  for (const sentence of chunkSentences) {
    const normSentence = normalizeText(sentence);
    // Token overlap coefficient
    const claimTokens = new Set(normClaim.split(' ').filter((w) => w.length > 3));
    const sentTokens = new Set(normSentence.split(' ').filter((w) => w.length > 3));

    let intersection = 0;
    for (const token of claimTokens) {
      if (sentTokens.has(token)) intersection++;
    }

    const score = claimTokens.size > 0 ? intersection / claimTokens.size : 0;
    if (score > bestScore && score >= 0.3) {
      bestScore = score;
      bestSentence = sentence;
    }
  }

  return bestSentence;
}

/**
 * Find bounding box for a given page on a chunk.
 */
function getBboxForPage(chunk: GroundedChunk, page: number): BoundingBox {
  const pageMatch = chunk.pages.find((p: ChunkPage) => p.page === page);
  if (pageMatch?.bbox) {
    return pageMatch.bbox;
  }
  return chunk.bbox ?? [0, 0, 0, 0];
}

/**
 * Verify citations against retrieved chunks mechanically.
 * Drops unverifiable citations and records rejection reasons.
 */
export function verifyCitations(
  rawText: string,
  retrievedChunks: readonly GroundedChunk[],
): CitationVerificationResult {
  const cleanAnswer = removeCitationsBlock(rawText);
  const chunksById = new Map<string, GroundedChunk>();
  for (const c of retrievedChunks) {
    chunksById.set(c.id, c);
  }

  const rawCitations = parseStructuredCitations(rawText);

  // If no structured citations emitted, fall back to inline markers
  if (rawCitations.length === 0) {
    const markers = parseInlineCitationMarkers(cleanAnswer);
    for (const marker of markers) {
      const chunk = chunksById.get(marker.chunkId);
      if (!chunk) continue;

      // Extract the text immediately preceding the marker (up to 200 chars or sentence boundary)
      const prevText = cleanAnswer.slice(Math.max(0, marker.index - 200), marker.index);
      const lastSentence = prevText.split(/[.?!]\s+/).pop() ?? prevText;
      const quote = findBestMatchingQuote(lastSentence, chunk.text);

      if (quote) {
        rawCitations.push({
          chunkId: marker.chunkId,
          page: marker.page,
          quote,
          documentId: chunk.documentId,
        });
      }
    }
  }

  const verified: Citation[] = [];
  const rejected: RejectedCitation[] = [];
  const seenQuotes = new Set<string>();

  for (const raw of rawCitations) {
    const chunk = chunksById.get(raw.chunkId);
    if (!chunk) {
      rejected.push({
        chunkId: raw.chunkId,
        page: raw.page,
        quote: raw.quote,
        reason: `Chunk ${raw.chunkId} not found in retrieved chunks`,
        documentId: raw.documentId,
      });
      continue;
    }

    // Verify page attribution
    const pageExists = chunk.pages.some((p: ChunkPage) => p.page === raw.page);
    if (!pageExists) {
      rejected.push({
        chunkId: raw.chunkId,
        page: raw.page,
        quote: raw.quote,
        reason: `Page ${raw.page} does not match chunk pages [${chunk.pages.map((p: ChunkPage) => p.page).join(', ')}]`,
        documentId: chunk.documentId,
      });
      continue;
    }

    // Verify quote text appears in chunk
    const normChunk = normalizeText(chunk.text);
    const normQuote = normalizeText(raw.quote);

    if (!normQuote) {
      rejected.push({
        chunkId: raw.chunkId,
        page: raw.page,
        quote: raw.quote,
        reason: 'Empty quote string',
        documentId: chunk.documentId,
      });
      continue;
    }

    const exactMatch = normChunk.includes(normQuote);
    const isVerified = exactMatch || fuzzyIncludes(normChunk, normQuote, 0.85);

    if (!isVerified) {
      rejected.push({
        chunkId: raw.chunkId,
        page: raw.page,
        quote: raw.quote,
        reason: 'Quote does not appear on cited page / chunk text',
        documentId: chunk.documentId,
      });
      continue;
    }

    // Deduplicate identical citations
    const key = `${chunk.id}:${raw.page}:${normQuote}`;
    if (seenQuotes.has(key)) continue;
    seenQuotes.add(key);

    const bbox = getBboxForPage(chunk, raw.page);
    verified.push({
      chunkId: chunk.id,
      page: raw.page,
      bbox,
      quote: raw.quote,
      documentId: chunk.documentId,
    });
  }

  return {
    verified,
    rejected,
    cleanAnswer,
  };
}
