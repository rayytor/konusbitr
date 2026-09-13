'use client';

import type { BoundingBox } from '@konusbitr/shared';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { loadPdfjs } from './pdf';

/**
 * Find-in-document.
 *
 * The browser's own Ctrl+F works on the text layer, and works well — but only
 * on the pages that are currently rendered, which in a virtualized 500-page
 * viewer is about four of them. This is the other half: a scan of the document's
 * text content that finds matches on pages nobody has scrolled to yet.
 *
 * **It produces boxes in Konusbitr's one coordinate convention without
 * converting anything itself.** `viewport.transform` at scale 1 with the page's
 * own `/Rotate` maps PDF user space onto exactly the frame
 * `docs/coordinates.md` defines — points, origin top-left, y down, visible
 * page — so the matches can be handed straight to the same highlight layer that
 * draws citations. Doing the flip and the rotation by hand here is what would
 * create a second, undocumented convention; asking PDF.js for its own transform
 * does not.
 */

export type SearchMatch = {
  id: string;
  page: number;
  bbox: BoundingBox;
};

type PageIndex = {
  /** The page's text, normalized for matching. */
  text: string;
  /** One entry per text run, with the range of `text` it occupies. */
  runs: { start: number; end: number; bbox: BoundingBox }[];
};

/**
 * Normalize for matching, preserving length.
 *
 * Length-preserving is the whole trick: a match found in the normalized string
 * has to map back to the same character offsets in the run table, so this may
 * fold case and substitute characters but must never insert or remove one.
 */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ');
}

const indexCache = new WeakMap<PDFDocumentProxy, Map<number, PageIndex>>();

async function pageIndex(pdf: PDFDocumentProxy, pageNumber: number): Promise<PageIndex> {
  let perDocument = indexCache.get(pdf);
  if (!perDocument) {
    perDocument = new Map();
    indexCache.set(pdf, perDocument);
  }

  const cached = perDocument.get(pageNumber);
  if (cached) return cached;

  const pdfjs = await loadPdfjs();
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1, rotation: page.rotate });
  const content = await page.getTextContent();

  let text = '';
  const runs: PageIndex['runs'] = [];

  for (const item of content.items) {
    if (!('str' in item)) continue;
    const start = text.length;
    text += item.str;
    const end = text.length;

    if (item.str.length > 0) {
      // The run's baseline-left corner and its extent, taken through PDF.js's
      // own viewport transform — see the note at the top of this file.
      // The run's baseline-left corner, taken through PDF.js's own viewport
      // transform — see the note at the top of this file. `applyTransform`
      // rewrites the point in place.
      const point: number[] = [item.transform[4] ?? 0, item.transform[5] ?? 0];
      pdfjs.Util.applyTransform(point, viewport.transform);
      const x = point[0] ?? 0;
      const yBaseline = point[1] ?? 0;
      const height = Math.abs(item.height || item.transform[3] || 0);
      const width = Math.abs(item.width || 0);
      runs.push({
        start,
        end,
        bbox: [x, yBaseline - height, x + width, yBaseline] as BoundingBox,
      });
    }

    if (item.hasEOL) text += '\n';
  }

  page.cleanup();

  const built = { text: normalize(text), runs };
  perDocument.set(pageNumber, built);
  return built;
}

/** Every run the match range touches, as one box per run. */
function matchBoxes(index: PageIndex, start: number, end: number): BoundingBox[] {
  return index.runs.filter((run) => run.start < end && run.end > start).map((run) => run.bbox);
}

export type SearchProgress = {
  matches: SearchMatch[];
  /** Pages scanned so far, out of `pageCount`. */
  scanned: number;
  done: boolean;
};

/** Stop scanning past this many hits; nobody pages through 2,000 of them. */
const MAX_MATCHES = 500;

/**
 * Scan the document for a query, reporting as it goes.
 *
 * Incremental because a cold scan of a 500-page document takes seconds, and a
 * search field that shows nothing until the last page is indistinguishable from
 * one that is broken. Pages are visited from `startPage` outward, so the first
 * hits reported are usually the ones nearest where the reader already is.
 */
export async function searchDocument(
  pdf: PDFDocumentProxy,
  query: string,
  options: {
    startPage: number;
    signal: AbortSignal;
    onProgress: (progress: SearchProgress) => void;
  },
): Promise<void> {
  const needle = normalize(query);
  const pageCount = pdf.numPages;

  if (needle.trim().length === 0) {
    options.onProgress({ matches: [], scanned: pageCount, done: true });
    return;
  }

  const order = Array.from({ length: pageCount }, (_unused, index) => {
    return ((options.startPage - 1 + index) % pageCount) + 1;
  });

  const matches: SearchMatch[] = [];
  let scanned = 0;

  for (const pageNumber of order) {
    if (options.signal.aborted) return;

    const index = await pageIndex(pdf, pageNumber);
    scanned += 1;

    let from = index.text.indexOf(needle);
    while (from !== -1 && matches.length < MAX_MATCHES) {
      const to = from + needle.length;
      for (const [box, bbox] of matchBoxes(index, from, to).entries()) {
        matches.push({ id: `search-${pageNumber}-${from}-${box}`, page: pageNumber, bbox });
      }
      from = index.text.indexOf(needle, to);
    }

    // Report on every page rather than at the end, and in document order so
    // "next match" walks forwards through the document rather than outwards
    // from wherever the scan happened to start.
    matches.sort((a, b) => a.page - b.page || a.bbox[1] - b.bbox[1]);
    options.onProgress({
      matches: [...matches],
      scanned,
      done: scanned === pageCount || matches.length >= MAX_MATCHES,
    });

    if (matches.length >= MAX_MATCHES) return;
  }
}
