import { EXTRACT_SMALL_SCHEMA_FIELDS } from './api-v2.js';

/**
 * What an API call costs, as arithmetic with no I/O in it.
 *
 * Kept here, pure and separately tested, because the accounting has to be
 * *exactly* right and because both halves of the product read it: the route
 * charges with it and the operator's usage view explains a bill with it. A
 * cost function that lived inside a route handler would be a cost function
 * nobody could unit-test against a table of expected values.
 *
 * The unit is a credit, an integer. Fractions are not representable on purpose:
 * `credit_ledger.delta` is an `integer` column, a ledger is a sequence of exact
 * additions, and a scheme that needed rounding at every row would not reconcile
 * against itself at the end of a month.
 */

/** Why a ledger row exists. Stored verbatim in `credit_ledger.reason`. */
export const CREDIT_REASONS = [
  'parse',
  'extract',
  'split',
  'ask',
  /** A zero-delta row recording that a call was served from the docId cache. */
  'cache_hit',
  /** An `advanced`-quality estimate, recorded against the monthly USD cap. */
  'vlm_parse',
  /** An operator or a payment adding credits. Positive delta. */
  'topup',
] as const;

export type CreditReason = (typeof CREDIT_REASONS)[number];

/**
 * Credits per page, per operation.
 *
 * `parse` is one per page: it is the operation whose cost genuinely is the
 * document. `ask` is flat rather than per-page because retrieval reads eight
 * chunks whether the document is ten pages or nine hundred — charging per page
 * for it would bill a 900-page document 900× for reading the same eight
 * passages. `split` is flat for the same reason from the other direction: it is
 * bytes in and bytes out, and the page count is not what makes it expensive.
 */
export const CREDIT_RATES = Object.freeze({
  parsePerPage: 1,
  /** Per page, for a schema of at most `EXTRACT_SMALL_SCHEMA_FIELDS` fields. */
  extractPerPageSmallSchema: 2,
  /** Per page, above it: more fields means more decomposed retrievals. */
  extractPerPageLargeSchema: 4,
  /** Flat, per call. */
  ask: 1,
  /** Flat, per call, regardless of how many outputs it produces. */
  split: 1,
});

/**
 * A document with no page count yet is charged as one page, never as zero.
 *
 * The count is unknown only for a document whose structural pass has not run,
 * which on the charging path means a URL import that failed validation — and a
 * free operation is a worse default than a minimum one, because it is the
 * shape an abuser would aim for.
 */
export const MINIMUM_BILLED_PAGES = 1;

function billablePages(pageCount: number | null | undefined): number {
  if (pageCount === null || pageCount === undefined) return MINIMUM_BILLED_PAGES;
  return Math.max(MINIMUM_BILLED_PAGES, Math.trunc(pageCount));
}

/** What a parse of this many pages costs. Zero when it was a cache hit. */
export function parseCost(pageCount: number | null | undefined, cached: boolean): number {
  if (cached) return 0;
  return billablePages(pageCount) * CREDIT_RATES.parsePerPage;
}

/**
 * What an extraction costs.
 *
 * The step at {@link EXTRACT_SMALL_SCHEMA_FIELDS} is not a pricing whim: above
 * it the extractor decomposes, running one retrieval per top-level field
 * instead of reading the document once, so the work really does roughly double.
 *
 * `fieldCount` is the schema's *top-level* field count, which is what the
 * decomposition fans out over. Counting leaves instead would charge four times
 * for a schema of two fields that each happen to be a nested object, which is
 * one retrieval, not two.
 */
export function extractCost(
  pageCount: number | null | undefined,
  fieldCount: number,
  options: { parseWasCached: boolean } = { parseWasCached: true },
): number {
  const rate =
    fieldCount <= EXTRACT_SMALL_SCHEMA_FIELDS
      ? CREDIT_RATES.extractPerPageSmallSchema
      : CREDIT_RATES.extractPerPageLargeSchema;
  const extraction = billablePages(pageCount) * rate;
  // An extraction against bytes nobody has parsed yet pays for the parse too;
  // against a `docId` it does not, which is the whole reason to keep a docId.
  return extraction + parseCost(pageCount, options.parseWasCached);
}

/** What an `ask` costs. Flat; a cached parse makes it cheaper, never free. */
export function askCost(
  pageCount: number | null | undefined,
  options: { parseWasCached: boolean } = { parseWasCached: true },
): number {
  return CREDIT_RATES.ask + parseCost(pageCount, options.parseWasCached);
}

/** What a split costs. Flat; the outputs are not charged for again. */
export function splitCost(
  pageCount: number | null | undefined,
  options: { parseWasCached: boolean } = { parseWasCached: true },
): number {
  return CREDIT_RATES.split + parseCost(pageCount, options.parseWasCached);
}
