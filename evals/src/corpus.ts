import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChunkPage } from '@konusbitr/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EVALS_DIR = join(HERE, '..');
const PAGES_FILE = join(EVALS_DIR, 'golden', 'pages.json');

/** One page of a fixture document, as `evals/extract-pages.py` dumped it. */
export type FixturePage = {
  page: number;
  width: number;
  height: number;
  rotation: number;
  text: string;
};

export type FixtureCorpus = Record<string, FixturePage[]>;

/**
 * The fixture corpus text, extracted from the PDFs themselves.
 *
 * Not re-derived in TypeScript from what `fixtures/generate.py` was told to
 * write: a second copy of the corpus drifts from the first, and then the eval is
 * measuring retrieval over text that is not in any document.
 */
export function loadFixtureCorpus(): FixtureCorpus {
  return JSON.parse(readFileSync(PAGES_FILE, 'utf-8')) as FixtureCorpus;
}

/** A chunk as the eval harness writes it into `chunks`. */
export type EvalChunk = {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  sectionPath: string | null;
  pages: ChunkPage[];
  tokenCount: number;
};

/**
 * How the eval corpus is cut into passages.
 *
 * `page` is the honest shape for this harness: the real chunker is layout-aware
 * and lives in Python, and reimplementing it here would mean the eval measured a
 * chunker that ships nowhere. What it does reproduce faithfully is the invariant
 * retrieval depends on — every chunk carries the page it came from — and pages
 * are split on sentence boundaries so a passage is a passage.
 *
 * `shredded` is the deliberately-broken comparison: fixed-width windows cut
 * without regard for sentences, and provenance smeared onto the wrong page. It
 * is what the CI regression gate is pointed at, and it drops recall because it
 * is genuinely worse, not because a counter says so.
 */
export type ChunkingMode = 'page' | 'shredded';

const TARGET_CHARS = 700;
const SHREDDED_CHARS = 120;

function splitOnSentences(text: string, target: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) ?? [text];
  const passages: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const candidate = current ? `${current}${sentence}` : sentence;
    if (candidate.trim().length >= target && current) {
      passages.push(current.trim());
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) {
    passages.push(current.trim());
  }
  return passages.length > 0 ? passages : [text];
}

function fixedWindows(text: string, size: number): string[] {
  const windows: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    windows.push(text.slice(i, i + size));
  }
  return windows.length > 0 ? windows : [text];
}

/**
 * Turn the fixture corpus into chunk rows.
 *
 * The document id is the fixture slug — the golden set addresses documents by
 * the name of the file the question was written against, and the harness creates
 * `documents` rows under those ids so nothing has to be mapped at eval time.
 */
export function buildEvalChunks(corpus: FixtureCorpus, mode: ChunkingMode = 'page'): EvalChunk[] {
  const chunks: EvalChunk[] = [];

  for (const [documentId, pages] of Object.entries(corpus)) {
    let ordinal = 0;

    for (const page of pages) {
      if (!page.text.trim()) {
        continue;
      }

      const bbox: [number, number, number, number] = [0, 0, page.width, page.height];
      const passages =
        mode === 'page'
          ? splitOnSentences(page.text, TARGET_CHARS)
          : fixedWindows(page.text, SHREDDED_CHARS);

      for (const passage of passages) {
        // The shredded mode also loses provenance: a chunk that reports the
        // wrong page cannot be cited, and the eval should see that as a miss.
        const attributedPage =
          mode === 'page' ? page.page : Math.max(1, page.page - (ordinal % 2 === 0 ? 0 : 1));

        chunks.push({
          id: `chk_${documentId}_${ordinal}`,
          documentId,
          ordinal,
          text: passage,
          sectionPath: null,
          pages: [{ page: attributedPage, bbox }],
          tokenCount: Math.max(1, Math.round(passage.split(/\s+/).length * 1.3)),
        });
        ordinal++;
      }
    }
  }

  return chunks;
}
