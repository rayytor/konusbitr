import {
  type PageRange,
  type ParsedElement,
  type SplitRange,
  sanitizeFilename,
} from '@konusbitr/shared';
import { ApiError } from '../errors';

/**
 * Deciding where to cut, which is the half of `split` that is not about PDFs.
 *
 * Both modes end in the same thing — a list of contiguous, 1-based inclusive
 * page ranges, each with a name — and that list is what crosses the seam to the
 * worker. The worker slices; this decides. Keeping the decision here is what
 * lets `semantic` read the parse artifact's section tree without the Python
 * half needing to know anything about a request body.
 */

/** `"1-4"` or `"7"` or `{ start, end, name? }` → a validated range. */
function normalize(range: PageRange, index: number, pageCount: number): SplitRange {
  let start: number;
  let end: number;
  let name: string | undefined;

  if (typeof range === 'string') {
    const [rawStart, rawEnd] = range.split('-');
    start = Number(rawStart);
    end = rawEnd === undefined ? start : Number(rawEnd);
  } else {
    start = range.start;
    end = range.end;
    name = range.name;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
    throw new ApiError('invalid_ranges', `Range ${index + 1} is not a pair of page numbers.`, {
      range,
    });
  }
  if (end < start) {
    throw new ApiError('invalid_ranges', `Range ${index + 1} ends before it starts.`, { range });
  }
  if (end > pageCount) {
    throw new ApiError(
      'invalid_ranges',
      `Range ${index + 1} asks for page ${end} of a ${pageCount}-page document.`,
      { range, pageCount },
    );
  }

  return { start, end, name: sanitizeFilename(name ?? defaultName(start, end)) };
}

function defaultName(start: number, end: number): string {
  return start === end ? `pages-${start}.pdf` : `pages-${start}-${end}.pdf`;
}

/**
 * Explicit ranges, validated.
 *
 * Overlap is allowed and duplication is not prevented: a caller extracting
 * "the appendix" and "pages 40-60" may legitimately want the same pages twice,
 * and refusing that would be inventing a rule upstream does not have. What is
 * refused is a range that cannot exist — reversed, zero-based, or off the end
 * of the document — because those are always mistakes.
 */
export function explicitRanges(ranges: readonly PageRange[], pageCount: number): SplitRange[] {
  if (pageCount < 1) {
    throw new ApiError('invalid_ranges', 'That document has no pages to split.');
  }
  return ranges.map((range, index) => normalize(range, index, pageCount));
}

/**
 * Cut at the document's own section boundaries, and name each output after the
 * heading it starts at.
 *
 * The section tree comes from the parse artifact, which means it comes from
 * whichever tier read the document: Docling's layout model on a born-digital
 * page, and the vision tier on a scan, since the OCR tier has no layout model
 * and emits no headings at all. A scanned document parsed at `standard` quality
 * therefore has no boundaries to cut at, and this says so rather than returning
 * the whole document as one "section" — a split that produced one output
 * identical to its input would look like it had worked.
 *
 * Headings are taken at exactly `level`, not at `level` or shallower. A
 * document whose chapters are level 1 and whose sections are level 2 splits
 * into chapters at level 1; mixing the two would produce overlapping outputs
 * where a chapter and its first section both started a range.
 */
export function semanticRanges(
  contents: readonly ParsedElement[],
  pageCount: number,
  level: number,
): SplitRange[] {
  const headings = contents
    .filter((element) => element.type === 'heading' && element.level === level)
    .sort((a, b) => a.page - b.page);

  if (headings.length === 0) {
    throw new ApiError(
      'invalid_ranges',
      `This document's parse found no level-${level} headings to split at.`,
      { level },
    );
  }

  // Several headings can share a page — a page of short subsections — and each
  // would otherwise start a zero- or negative-length range. The first heading on
  // a page owns the boundary; the rest are titles inside the section that page
  // begins.
  const boundaries: { page: number; title: string }[] = [];
  for (const heading of headings) {
    if (boundaries.at(-1)?.page === heading.page) continue;
    boundaries.push({ page: heading.page, title: (heading.text ?? '').trim() });
  }

  const first = boundaries[0];
  if (!first) throw new ApiError('invalid_ranges', 'No usable heading boundaries were found.');

  const ranges: SplitRange[] = [];

  // Anything before the first heading is a real part of the document — a title
  // page, a table of contents, a covering letter — and dropping it would lose
  // pages from a split that claims to cover the document.
  if (first.page > 1) {
    ranges.push({ start: 1, end: first.page - 1, name: sanitizeFilename('front-matter.pdf') });
  }

  boundaries.forEach((boundary, index) => {
    const next = boundaries[index + 1];
    const end = next ? next.page - 1 : pageCount;
    if (end < boundary.page) return;
    ranges.push({
      start: boundary.page,
      end,
      name: sanitizeFilename(`${sectionSlug(boundary.title, index)}.pdf`),
    });
  });

  return ranges;
}

/**
 * A heading turned into a filename.
 *
 * Deliberately lossy and deliberately bounded. A heading is document text, and
 * document text is untrusted — it reaches a filename, a storage listing and
 * somebody's download folder. So it is reduced to lowercase ASCII words and
 * hyphens, capped, and given a positional fallback when nothing usable
 * survives. `sanitizeFilename` runs over the result as well, which is belt and
 * braces on purpose: this is the one place where a document gets to name a file.
 */
export function sectionSlug(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    // Letters Unicode does not decompose, folded by hand. `ı` is the one that
    // makes this necessary: it is a letter in its own right, not an `i` with
    // something removed, so NFKD leaves it whole and the ASCII filter below
    // deletes it — turning "Başlığı" into "basl-g". A Turkish heading is the
    // ordinary case for this product, not an edge one.
    .replace(/[ıİ]/g, 'i')
    .replace(/ø/g, 'o')
    .replace(/[đð]/g, 'd')
    .replace(/ł/g, 'l')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/ß/g, 'ss')
    .replace(/þ/g, 'th')
    .normalize('NFKD')
    // Combining marks, which NFKD has just separated out. Dropping them turns
    // "Bölüm" into "bolum" rather than into "b-l-m".
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');

  return slug || `section-${index + 1}`;
}
