import { describe, expect, it } from 'vitest';
import {
  askCost,
  CREDIT_RATES,
  extractCost,
  MINIMUM_BILLED_PAGES,
  parseCost,
  splitCost,
} from '../src/credits.js';

/**
 * The accounting, against a table of expected values.
 *
 * This is the one part of the API where "roughly right" is not a passing
 * grade: a caller is billed by these functions, and an operator reconciles a
 * month against them. So they are pure, they live away from any I/O, and every
 * documented rule in the phase has a case here — including the two that are
 * easy to get subtly wrong, which are the schema-size step in `extract` and the
 * rule that a `docId` reuse is free.
 */

describe('parseCost', () => {
  it('charges one credit per page', () => {
    expect(parseCost(10, false)).toBe(10);
    expect(parseCost(1, false)).toBe(1);
    expect(parseCost(900, false)).toBe(900);
  });

  it('charges nothing for a cache hit, however long the document', () => {
    expect(parseCost(900, true)).toBe(0);
    expect(parseCost(1, true)).toBe(0);
    expect(parseCost(null, true)).toBe(0);
  });

  it('bills a document of unknown length as one page, never as zero', () => {
    // Free is a worse default than a minimum: it is the shape an abuser aims
    // for, and an unknown page count on the charging path means a file that
    // hid its page objects rather than a file with no pages.
    expect(parseCost(null, false)).toBe(MINIMUM_BILLED_PAGES);
    expect(parseCost(undefined, false)).toBe(MINIMUM_BILLED_PAGES);
    expect(parseCost(0, false)).toBe(MINIMUM_BILLED_PAGES);
  });

  it('ignores a fractional page count rather than rounding it up', () => {
    expect(parseCost(10.9, false)).toBe(10);
  });
});

describe('extractCost', () => {
  it('is twice the page count for a schema of five fields or fewer', () => {
    for (const fields of [1, 2, 3, 4, 5]) {
      expect(extractCost(10, fields)).toBe(20);
    }
    expect(CREDIT_RATES.extractPerPageSmallSchema).toBe(2);
  });

  it('is four times the page count above five fields', () => {
    expect(extractCost(10, 6)).toBe(40);
    expect(extractCost(10, 40)).toBe(40);
    expect(CREDIT_RATES.extractPerPageLargeSchema).toBe(4);
  });

  it('steps exactly between five and six fields', () => {
    expect(extractCost(7, 5)).toBe(14);
    expect(extractCost(7, 6)).toBe(28);
  });

  it('adds the parse when the document had to be parsed for it', () => {
    // 10 pages × 2 for the extraction, plus 10 for the parse it caused.
    expect(extractCost(10, 3, { parseWasCached: false })).toBe(30);
    // The same call against a docId pays for the extraction alone, which is
    // the entire reason to keep a docId.
    expect(extractCost(10, 3, { parseWasCached: true })).toBe(20);
  });
});

describe('askCost', () => {
  it('is flat, whatever the document costs to store', () => {
    // Retrieval reads eight chunks whether the document is ten pages or nine
    // hundred; charging per page would bill 900× for reading the same eight.
    expect(askCost(10)).toBe(CREDIT_RATES.ask);
    expect(askCost(900)).toBe(CREDIT_RATES.ask);
    expect(askCost(null)).toBe(CREDIT_RATES.ask);
  });

  it('adds the parse when the question caused one', () => {
    expect(askCost(50, { parseWasCached: false })).toBe(CREDIT_RATES.ask + 50);
  });
});

describe('splitCost', () => {
  it('is flat, and does not charge again for the outputs', () => {
    expect(splitCost(100)).toBe(CREDIT_RATES.split);
  });

  it('adds the parse when the split caused one', () => {
    expect(splitCost(100, { parseWasCached: false })).toBe(CREDIT_RATES.split + 100);
  });
});

describe('the ledger arithmetic as a whole', () => {
  it('makes a repeat call against a docId strictly cheaper than the first', () => {
    const first = parseCost(120, false) + extractCost(120, 8, { parseWasCached: false });
    const second = parseCost(120, true) + extractCost(120, 8, { parseWasCached: true });
    expect(second).toBeLessThan(first);
    expect(second).toBe(extractCost(120, 8));
  });
});
