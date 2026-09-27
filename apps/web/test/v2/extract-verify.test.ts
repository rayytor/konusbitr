import type { GroundedChunk } from '@konusbitr/ai';
import { describe, expect, it } from 'vitest';
import { pageTextIndex, parseModelJson } from '@/lib/v2/extract/engine';
import { fieldQuery, validateExtractionSchema } from '@/lib/v2/extract/schema';
import { deleteAtPath, leafPaths, readAtPath, verifyExtraction } from '@/lib/v2/extract/verify';

/**
 * The half of `extract` that decides what a caller is allowed to receive.
 *
 * The rule under test throughout: a value whose quote is not in the document is
 * not returned. It is set to `null` and listed in `unverified`. A number that
 * came from nowhere is strictly worse than a missing field, because somebody
 * will put it in a spreadsheet.
 */

function chunk(id: string, text: string, page: number): GroundedChunk {
  return {
    id,
    documentId: 'doc_test',
    text,
    pages: [{ page, bbox: [10, 20, 300, 40] }],
    page,
  };
}

const EMPTY = { chunks: [] as GroundedChunk[], pageText: new Map<number, string>() };

describe('validateExtractionSchema', () => {
  it('accepts an ordinary object schema and reports its shape', () => {
    const summary = validateExtractionSchema({
      type: 'object',
      properties: {
        invoiceNumber: { type: 'string' },
        total: { type: 'number' },
        lineItems: {
          type: 'array',
          items: { type: 'object', properties: { sku: { type: 'string' } } },
        },
      },
    });
    expect(summary.topLevelFields).toEqual(['invoiceNumber', 'total', 'lineItems']);
    expect(summary.leafCount).toBeGreaterThan(0);
  });

  it('refuses anything that is not an object schema with properties', () => {
    expect(() => validateExtractionSchema({ type: 'string' })).toThrow(/at least one property/);
    expect(() => validateExtractionSchema([])).toThrow(/JSON Schema object/);
    expect(() => validateExtractionSchema({ type: 'object', properties: {} })).toThrow();
  });

  it('refuses a schema nested past the depth limit', () => {
    let node: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 12; i++) node = { type: 'object', properties: { nested: node } };
    expect(() => validateExtractionSchema(node)).toThrow(/nests deeper than/);
  });

  it('refuses a schema with too many top-level fields', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`field${i}`, { type: 'string' }]),
    );
    expect(() => validateExtractionSchema({ type: 'object', properties })).toThrow(
      /top-level fields/,
    );
  });

  it('refuses a schema larger than the byte limit', () => {
    const properties = {
      big: { type: 'string', description: 'x'.repeat(70_000) },
    };
    expect(() => validateExtractionSchema({ type: 'object', properties })).toThrow(/bytes/);
  });

  it('counts an array of objects once rather than per element', () => {
    // The document decides how many items there are; the schema describes one.
    const summary = validateExtractionSchema({
      type: 'object',
      properties: {
        people: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, role: { type: 'string' } },
          },
        },
      },
    });
    expect(summary.leafCount).toBe(2);
  });
});

describe('fieldQuery', () => {
  it('turns a camelCase field name into words', () => {
    expect(fieldQuery('invoiceTotal', undefined)).toBe('invoice Total');
  });

  it('uses the caller`s description, which is the cheapest quality lever they have', () => {
    const query = fieldQuery('total', { description: 'The total amount due including tax' });
    expect(query).toContain('total amount due including tax');
  });

  it('searches for an array element`s property names rather than the collection`s', () => {
    const query = fieldQuery('people', {
      type: 'array',
      items: { type: 'object', properties: { name: {}, role: {} } },
    });
    expect(query).toContain('name role');
  });
});

describe('readAtPath and deleteAtPath', () => {
  it('addresses nested objects and array indices', () => {
    const result = { invoice: { total: 42 }, people: [{ name: 'Ada' }, { name: 'Alan' }] };
    expect(readAtPath(result, 'result.invoice.total')).toEqual({ found: true, value: 42 });
    expect(readAtPath(result, 'result.people[1].name')).toEqual({ found: true, value: 'Alan' });
  });

  it('reports a path that is not in the result rather than inventing one', () => {
    expect(readAtPath({}, 'result.nothing.here').found).toBe(false);
    expect(readAtPath({ list: [] }, 'result.list[3]').found).toBe(false);
  });

  it('nulls an array element rather than splicing it out', () => {
    // Removing it would renumber every index after it, and the evidence for
    // those values addresses them by index. A hole is honest; a shifted array
    // is silently wrong.
    const root = { result: { people: [{ name: 'Ada' }, { name: 'Alan' }] } };
    deleteAtPath(root, 'result.people[0]');
    expect(root.result.people).toEqual([null, { name: 'Alan' }]);
  });

  it('nulls an object property', () => {
    const root = { result: { invoice: { total: 42 } } };
    deleteAtPath(root, 'result.invoice.total');
    expect(root.result.invoice.total).toBeNull();
  });
});

describe('leafPaths', () => {
  it('enumerates every scalar position', () => {
    expect(leafPaths({ a: 1, b: { c: 'x' }, d: [true, false] }).sort()).toEqual([
      'result.a',
      'result.b.c',
      'result.d[0]',
      'result.d[1]',
    ]);
  });
});

describe('verifyExtraction against retrieved chunks', () => {
  const chunks = [
    chunk('chk_1', 'The total amount due is £1,284,567 payable within 30 days.', 4),
    chunk('chk_2', 'Prepared by Ada Lovelace, Chief Analyst.', 9),
  ];

  it('keeps a value whose quote is verbatim in a retrieved chunk', () => {
    const result: Record<string, unknown> = { total: '£1,284,567' };
    const { citations, unverified } = verifyExtraction(
      result,
      [{ schemaPath: 'result.total', quote: '£1,284,567', page: 4, chunkId: 'chk_1' }],
      { chunks, pageText: new Map() },
    );

    expect(unverified).toEqual([]);
    expect(result.total).toBe('£1,284,567');
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      page: 4,
      chunkId: 'chk_1',
      schemaPath: 'result.total',
      bbox: [10, 20, 300, 40],
    });
  });

  it('drops the value, not merely the citation, when the quote is invented', () => {
    const result: Record<string, unknown> = { total: '£1,234,567' };
    const { citations, unverified } = verifyExtraction(
      result,
      [{ schemaPath: 'result.total', quote: '£1,234,567', page: 4, chunkId: 'chk_1' }],
      { chunks, pageText: new Map() },
    );

    expect(citations).toEqual([]);
    expect(result.total).toBeNull();
    expect(unverified[0]).toMatchObject({
      schemaPath: 'result.total',
      value: '£1,234,567',
      reason: expect.stringContaining('does not appear'),
    });
  });

  it('drops a value the model gave no evidence for at all', () => {
    const result: Record<string, unknown> = { total: '£1,284,567', invoiceNumber: 'INV-1' };
    const { unverified } = verifyExtraction(
      result,
      [{ schemaPath: 'result.total', quote: '£1,284,567', page: 4, chunkId: 'chk_1' }],
      { chunks, pageText: new Map() },
    );

    expect(result.total).toBe('£1,284,567');
    expect(result.invoiceNumber).toBeNull();
    expect(unverified.map((entry) => entry.schemaPath)).toEqual(['result.invoiceNumber']);
    expect(unverified[0]?.reason).toContain('no quote');
  });

  it('checks the quote against the document, not the value against the quote', () => {
    // The documented boundary, asserted so that it is a decision rather than an
    // assumption. Verification answers "is this sentence really in the
    // document", which is what catches an invented quote — and it does not
    // answer "does this sentence support this value", which would need the
    // value to be a substring of the quote. It is not: a `number` field is
    // `1284567` from "£1,284,567", and a date field is `2026-04-01` from "1
    // April 2026". A rule strict enough to catch the case below would reject
    // both of those, so this is left to the model and the quote is returned
    // beside the value for a caller to see.
    const result: Record<string, unknown> = { total: '£99' };
    const { citations, unverified } = verifyExtraction(
      result,
      [{ schemaPath: 'result.total', quote: '£1,284,567', page: 4, chunkId: 'chk_1' }],
      { chunks, pageText: new Map() },
    );

    expect(unverified).toEqual([]);
    expect(citations[0]?.quote).toBe('£1,284,567');
    expect(result.total).toBe('£99');
  });

  it('leaves a null alone, because a null was never a claim', () => {
    const result: Record<string, unknown> = { total: null };
    const { citations, unverified } = verifyExtraction(result, [], EMPTY);
    expect(citations).toEqual([]);
    expect(unverified).toEqual([]);
    expect(result.total).toBeNull();
  });

  it('accepts a quote found under a different chunk id than the model named', () => {
    // A model that cited the right passage under the wrong id has still found
    // the right passage; discarding a correct value over a mistyped identifier
    // would be pedantry.
    const result: Record<string, unknown> = { author: 'Ada Lovelace' };
    const { citations } = verifyExtraction(
      result,
      [{ schemaPath: 'result.author', quote: 'Ada Lovelace', page: 9, chunkId: 'chk_wrong' }],
      { chunks, pageText: new Map() },
    );
    expect(citations[0]?.chunkId).toBe('chk_2');
    expect(citations[0]?.page).toBe(9);
  });

  it('takes the page from the chunk that holds the quote, not from the model', () => {
    const result: Record<string, unknown> = { author: 'Ada Lovelace' };
    const { citations } = verifyExtraction(
      result,
      [{ schemaPath: 'result.author', quote: 'Ada Lovelace', page: 77, chunkId: 'chk_2' }],
      { chunks, pageText: new Map() },
    );
    expect(citations[0]?.page).toBe(9);
  });

  it('survives hyphenation and ligature noise', () => {
    const noisy = [chunk('chk_3', 'The quarterly state-\nment was approved.', 2)];
    const result: Record<string, unknown> = { note: 'The quarterly statement was approved.' };
    const { citations } = verifyExtraction(
      result,
      [
        {
          schemaPath: 'result.note',
          quote: 'The quarterly statement was approved.',
          page: 2,
          chunkId: 'chk_3',
        },
      ],
      { chunks: noisy, pageText: new Map() },
    );
    expect(citations).toHaveLength(1);
  });

  it('verifies each leaf of an array independently', () => {
    const arrayChunks = [chunk('chk_4', 'Attendees: Ada Lovelace and Alan Turing.', 1)];
    const result: Record<string, unknown> = { people: ['Ada Lovelace', 'Grace Hopper'] };
    const { citations, unverified } = verifyExtraction(
      result,
      [
        { schemaPath: 'result.people[0]', quote: 'Ada Lovelace', page: 1, chunkId: 'chk_4' },
        { schemaPath: 'result.people[1]', quote: 'Grace Hopper', page: 1, chunkId: 'chk_4' },
      ],
      { chunks: arrayChunks, pageText: new Map() },
    );

    expect(citations).toHaveLength(1);
    expect(result.people).toEqual(['Ada Lovelace', null]);
    expect(unverified).toHaveLength(1);
  });
});

describe('verifyExtraction against whole-document text', () => {
  const pageText = pageTextIndex([
    {
      type: 'paragraph',
      page: 3,
      bbox: [0, 0, 1, 1],
      text: 'The agreement commences on 1 April 2026.',
      markdown: null,
      headers: null,
      rows: null,
      level: null,
      sectionPath: null,
    },
  ]);

  it('accepts a quote that appears on the page it cites', () => {
    const result: Record<string, unknown> = { start: '1 April 2026' };
    const { citations } = verifyExtraction(
      result,
      [{ schemaPath: 'result.start', quote: '1 April 2026', page: 3 }],
      { chunks: [], pageText },
    );
    expect(citations).toHaveLength(1);
    // No box on this path, and a zero rectangle rather than an invented one:
    // the whole-markdown reading knows the page and genuinely not the place.
    expect(citations[0]?.bbox).toEqual([0, 0, 0, 0]);
  });

  it('rejects a real quote cited against the wrong page', () => {
    const result: Record<string, unknown> = { start: '1 April 2026' };
    const { unverified } = verifyExtraction(
      result,
      [{ schemaPath: 'result.start', quote: '1 April 2026', page: 8 }],
      { chunks: [], pageText },
    );
    expect(unverified[0]?.reason).toContain('Page 8');
  });

  it('rejects a value with no page at all', () => {
    const result: Record<string, unknown> = { start: '1 April 2026' };
    const { unverified } = verifyExtraction(
      result,
      [{ schemaPath: 'result.start', quote: '1 April 2026', page: null }],
      { chunks: [], pageText },
    );
    expect(unverified[0]?.reason).toContain('No page');
  });
});

describe('parseModelJson', () => {
  it('reads a bare object', () => {
    const parsed = parseModelJson('{"result":{"a":1},"evidence":[]}');
    expect(parsed.result).toEqual({ a: 1 });
  });

  it('reads an object inside a code fence', () => {
    const parsed = parseModelJson('```json\n{"result":{"a":1},"evidence":[]}\n```');
    expect(parsed.result).toEqual({ a: 1 });
  });

  it('reads an object a model wrapped in prose', () => {
    const parsed = parseModelJson(
      'Here you go:\n{"result":{"a":1},"evidence":[]}\nHope that helps.',
    );
    expect(parsed.result).toEqual({ a: 1 });
  });

  it('unwraps a model that returned the object itself', () => {
    const parsed = parseModelJson('{"invoiceNumber":"INV-1"}');
    expect(parsed.result).toEqual({ invoiceNumber: 'INV-1' });
  });

  it('keeps only evidence entries that address the result', () => {
    const parsed = parseModelJson(
      '{"result":{},"evidence":[{"schemaPath":"result.a","quote":"x","page":1},{"schemaPath":"nonsense","quote":"y","page":1}]}',
    );
    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.evidence[0]?.schemaPath).toBe('result.a');
  });

  it('raises a documented error rather than a parse exception', () => {
    expect(() => parseModelJson('I could not do that.')).toThrow(/usable JSON/);
  });
});
