import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_VLM_PAGES_PER_JOB,
  DEFAULT_TIER_FALLBACK_THRESHOLD,
  DEFAULT_VLM_DPI,
  EstimateCostRequestSchema,
  EstimateCostResponseSchema,
  estimateVlmCost,
  formatUsd,
  imageTokensPerPage,
  VLM_IMAGE_MAX_EDGE,
  VLM_MODEL_PRICES,
} from '../src/index.js';

/**
 * The cost arithmetic the confirmation modal quotes from.
 *
 * This is the number somebody agrees to before an advanced parse runs, and the
 * number the monthly cap is enforced against, so the tests below are about the
 * two ways it can be wrong in a way nobody notices: an estimate that does not
 * scale with what is actually sent, and a zero that means two different things.
 *
 * The Python half is pinned against this file by `test_vlm_cost.py`, which
 * reads these constants out of the source rather than restating them.
 */

describe('imageTokensPerPage', () => {
  it('stops growing once the long edge passes the resample cap', () => {
    // The cap is what makes the estimate a function of the page *count* rather
    // than of the page sizes. Above it a provider resamples before it looks, so
    // the extra pixels are rendered, sent and discarded.
    expect(imageTokensPerPage(400)).toBe(imageTokensPerPage(300));
  });

  it('grows below the cap, because that render is what is sent', () => {
    expect(imageTokensPerPage(72)).toBeLessThan(imageTokensPerPage(120));
  });

  it('matches the resampled page rather than the rendered one', () => {
    // A Letter page at 180 DPI is 1530 x 1980 and the long edge is past 1568.
    const scale = VLM_IMAGE_MAX_EDGE / 1980;
    const expected = Math.ceil((1530 * scale * (1980 * scale)) / 750);
    expect(imageTokensPerPage(DEFAULT_VLM_DPI)).toBe(expected);
  });
});

describe('estimateVlmCost', () => {
  const openai = { model: 'gpt-4.1-mini', provider: 'openai' } as const;

  it('prices a listed model from the table', () => {
    const estimate = estimateVlmCost({ pageCount: 10, ...openai });
    expect(estimate.pricedFrom).toBe('table');
    expect(estimate.estimatedUsd).toBeGreaterThan(0);
  });

  it('admits when a model is not in the table rather than quoting zero', () => {
    // A confident `$0.00` for an unknown model is worse than an admitted guess,
    // so the fallback is deliberately not cheap and the UI is told it is one.
    const estimate = estimateVlmCost({
      pageCount: 10,
      model: 'some-model-released-last-tuesday',
      provider: 'openai',
    });
    expect(estimate.pricedFrom).toBe('fallback');
    expect(estimate.estimatedUsd).toBeGreaterThan(0);
  });

  it('prices a local model as null, never as zero', () => {
    // "No charge" and "we could not work it out" render identically as $0.00
    // and mean opposite things to somebody deciding whether to press a button.
    const estimate = estimateVlmCost({
      pageCount: 10,
      model: 'ollama/qwen2.5vl:7b',
      provider: 'ollama',
    });
    expect(estimate.pricedFrom).toBe('local');
    expect(estimate.estimatedUsd).toBeNull();
  });

  it('lets an operator override the published rate', () => {
    const estimate = estimateVlmCost({ pageCount: 10, ...openai, usdPerPageOverride: 0.02 });
    expect(estimate.pricedFrom).toBe('operator');
    expect(estimate.estimatedUsd).toBeCloseTo(0.2, 6);
  });

  it('scales linearly with pages', () => {
    const one = estimateVlmCost({ pageCount: 1, ...openai });
    const fifty = estimateVlmCost({ pageCount: 50, ...openai });

    // Tokens are exact; the dollar figure is rounded to six places per estimate,
    // so scaling a rounded single page by fifty is off by a fraction of a cent.
    // That is the arithmetic being correct, not a tolerance being fudged — the
    // estimate is presented as "about" precisely because this is its resolution.
    expect(fifty.promptTokens).toBe(one.promptTokens * 50);
    expect(fifty.completionTokens).toBe(one.completionTokens * 50);
    expect(fifty.estimatedUsd ?? 0).toBeCloseTo((one.estimatedUsd ?? 0) * 50, 4);
  });

  it('costs nothing for no pages', () => {
    const estimate = estimateVlmCost({ pageCount: 0, ...openai });
    expect(estimate.estimatedUsd).toBe(0);
    expect(estimate.promptTokens).toBe(0);
    expect(estimate.completionTokens).toBe(0);
  });

  it('accounts for concurrency in the latency estimate', () => {
    const estimate = estimateVlmCost({ pageCount: 30, ...openai });
    // Thirty pages three at a time at six seconds each.
    expect(estimate.estimatedSeconds).toBe(60);
  });

  it('every listed price is a positive pair', () => {
    for (const [model, price] of Object.entries(VLM_MODEL_PRICES)) {
      expect(price[0], model).toBeGreaterThan(0);
      expect(price[1], model).toBeGreaterThan(0);
    }
  });
});

describe('formatUsd', () => {
  it('does not round a sub-cent amount away to nothing', () => {
    // A single cheap page really is fractions of a cent, and rendering it as
    // $0.00 makes a priced estimate indistinguishable from an unpriced one.
    expect(formatUsd(0.004)).toBe('$0.004');
  });

  it('uses two places once there are cents to show', () => {
    expect(formatUsd(0.42)).toBe('$0.42');
    expect(formatUsd(12.5)).toBe('$12.50');
  });

  it('renders a genuine zero as zero', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });
});

describe('the endpoint contract', () => {
  it('defaults a request to the advanced tier', () => {
    expect(EstimateCostRequestSchema.parse({ pageCount: 12 }).quality).toBe('advanced');
  });

  it('refuses a zero or negative page count', () => {
    expect(EstimateCostRequestSchema.safeParse({ pageCount: 0 }).success).toBe(false);
    expect(EstimateCostRequestSchema.safeParse({ pageCount: -3 }).success).toBe(false);
  });

  it('accepts a refusal as a well-formed answer', () => {
    // "No, because the document is too long" is an answer to the question this
    // endpoint asks, not a bad request — so the response shape has to carry it.
    const parsed = EstimateCostResponseSchema.safeParse({
      quality: 'advanced',
      pageCount: 400,
      allowed: false,
      reason: 'too_many_pages',
      message: 'That document has 400 pages.',
      maxPages: DEFAULT_MAX_VLM_PAGES_PER_JOB,
      estimate: estimateVlmCost({ pageCount: 400, model: 'gpt-4o', provider: 'openai' }),
      spend: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('allows a null price in the response', () => {
    const parsed = EstimateCostResponseSchema.safeParse({
      quality: 'advanced',
      pageCount: 5,
      allowed: true,
      reason: null,
      message: 'ok',
      maxPages: DEFAULT_MAX_VLM_PAGES_PER_JOB,
      estimate: estimateVlmCost({ pageCount: 5, model: 'ollama/qwen2.5vl:7b', provider: 'ollama' }),
      spend: null,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('the defaults the phase specifies', () => {
  it('reads at most fifty pages in one job', () => {
    expect(DEFAULT_MAX_VLM_PAGES_PER_JOB).toBe(50);
  });

  it('escalates a page below 0.60 confidence', () => {
    expect(DEFAULT_TIER_FALLBACK_THRESHOLD).toBe(0.6);
  });

  it('renders pages in the 150-200 DPI band the phase names', () => {
    expect(DEFAULT_VLM_DPI).toBeGreaterThanOrEqual(150);
    expect(DEFAULT_VLM_DPI).toBeLessThanOrEqual(200);
  });
});
