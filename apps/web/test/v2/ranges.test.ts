import type { ParsedElement } from '@konusbitr/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/v2/errors';
import { explicitRanges, sectionSlug, semanticRanges } from '@/lib/v2/split/ranges';

/**
 * Where a split cuts.
 *
 * The arithmetic is small and every off-by-one in it produces a document that
 * looks plausible and is wrong by a page, which is the hardest kind of bug to
 * notice in a PDF.
 */

function heading(page: number, text: string, level = 1): ParsedElement {
  return {
    type: 'heading',
    page,
    bbox: [0, 0, 100, 20],
    text,
    markdown: null,
    headers: null,
    rows: null,
    level,
    sectionPath: null,
  };
}

function paragraph(page: number): ParsedElement {
  return { ...heading(page, 'body'), type: 'paragraph', level: null };
}

describe('explicitRanges', () => {
  it('reads upstream`s string form', () => {
    expect(explicitRanges(['1-4', '7'], 10)).toEqual([
      { start: 1, end: 4, name: 'pages-1-4.pdf' },
      { start: 7, end: 7, name: 'pages-7.pdf' },
    ]);
  });

  it('reads the object form and keeps the caller`s name', () => {
    expect(explicitRanges([{ start: 2, end: 3, name: 'appendix.pdf' }], 10)).toEqual([
      { start: 2, end: 3, name: 'appendix.pdf' },
    ]);
  });

  it('includes both ends of a range', () => {
    const [range] = explicitRanges(['1-3'], 3);
    expect(range?.start).toBe(1);
    expect(range?.end).toBe(3);
  });

  it('refuses a range that runs off the end of the document', () => {
    expect(() => explicitRanges(['1-11'], 10)).toThrow(ApiError);
    try {
      explicitRanges(['1-11'], 10);
    } catch (error) {
      expect((error as ApiError).code).toBe('invalid_ranges');
      expect((error as ApiError).message).toContain('page 11');
    }
  });

  it('refuses a reversed or zero-based range', () => {
    expect(() => explicitRanges(['5-2'], 10)).toThrow(/ends before it starts/);
    expect(() => explicitRanges(['0-2'], 10)).toThrow(/not a pair of page numbers/);
  });

  it('allows overlap, because a caller may legitimately want the pages twice', () => {
    const ranges = explicitRanges(['1-5', '3-7'], 10);
    expect(ranges).toHaveLength(2);
  });

  it('refuses to split a document with no pages', () => {
    expect(() => explicitRanges(['1'], 0)).toThrow(/no pages to split/);
  });
});

describe('semanticRanges', () => {
  const contents = [
    heading(1, 'Introduction'),
    paragraph(2),
    heading(3, 'Methods'),
    paragraph(4),
    heading(6, 'Results'),
  ];

  it('cuts at each heading and names the output after it', () => {
    expect(semanticRanges(contents, 8, 1)).toEqual([
      { start: 1, end: 2, name: 'introduction.pdf' },
      { start: 3, end: 5, name: 'methods.pdf' },
      { start: 6, end: 8, name: 'results.pdf' },
    ]);
  });

  it('keeps the pages before the first heading as front matter', () => {
    const withCover = [heading(3, 'Chapter One'), heading(5, 'Chapter Two')];
    expect(semanticRanges(withCover, 6, 1)).toEqual([
      { start: 1, end: 2, name: 'front-matter.pdf' },
      { start: 3, end: 4, name: 'chapter-one.pdf' },
      { start: 5, end: 6, name: 'chapter-two.pdf' },
    ]);
  });

  it('covers every page of the document exactly once', () => {
    const ranges = semanticRanges(contents, 8, 1);
    const covered = ranges.flatMap((range) =>
      Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i),
    );
    expect(covered).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('takes the first heading on a shared page as the boundary', () => {
    // Several subsections on one page would otherwise each start a
    // zero-length range.
    const crowded = [heading(1, 'A'), heading(1, 'B'), heading(1, 'C'), heading(4, 'D')];
    expect(semanticRanges(crowded, 5, 1)).toEqual([
      { start: 1, end: 3, name: 'a.pdf' },
      { start: 4, end: 5, name: 'd.pdf' },
    ]);
  });

  it('cuts at exactly the requested level, not at that level or shallower', () => {
    const nested = [heading(1, 'Chapter', 1), heading(2, 'Section', 2), heading(4, 'Two', 1)];
    expect(semanticRanges(nested, 6, 1).map((range) => range.name)).toEqual([
      'chapter.pdf',
      'two.pdf',
    ]);
    expect(semanticRanges(nested, 6, 2).map((range) => range.name)).toEqual([
      'front-matter.pdf',
      'section.pdf',
    ]);
  });

  it('refuses rather than returning the whole document as one section', () => {
    // A scan parsed at standard quality has no headings. Returning one output
    // identical to the input would look like it had worked.
    expect(() => semanticRanges([paragraph(1), paragraph(2)], 2, 1)).toThrow(/no level-1 headings/);
  });
});

describe('sectionSlug', () => {
  it('turns a heading into a safe, lowercase filename stem', () => {
    expect(sectionSlug('Chapter 2: Methods & Results', 0)).toBe('chapter-2-methods-results');
  });

  it('folds accents rather than dropping the letters', () => {
    expect(sectionSlug('Bölüm Başlığı', 0)).toBe('bolum-basligi');
  });

  it('never lets document text become a path', () => {
    expect(sectionSlug('../../etc/passwd', 0)).toBe('etc-passwd');
    expect(sectionSlug('/absolute/path', 0)).toBe('absolute-path');
  });

  it('falls back to a position when nothing usable survives', () => {
    expect(sectionSlug('第一章', 2)).toBe('section-3');
    expect(sectionSlug('   ', 0)).toBe('section-1');
  });

  it('bounds the length', () => {
    expect(sectionSlug('a'.repeat(300), 0).length).toBeLessThanOrEqual(60);
  });
});
