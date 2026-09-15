import { z } from 'zod';
import { isLocalProvider, type LlmProvider } from './models.js';

/**
 * The advanced (VLM) tier's cost arithmetic, stated once for both runtimes.
 *
 * Phase 12.3 adds a parser that reads a page by *looking* at it, which is the
 * only way to get reading order right on a multi-column magazine — and the only
 * stage of this pipeline whose cost scales with the page count times a
 * provider's token price. A 400-page filing parsed at `quality: "advanced"`
 * against a frontier model is a bill somebody did not agree to, so the estimate
 * is shown before the job is created and a hard ceiling refuses the rest.
 *
 * Everything here is deliberately arithmetic on plain numbers with no I/O, for
 * the same reason `parse-settings.ts` is: it has to be importable by the
 * browser (the confirmation modal), by the API route (the intake guard), and —
 * mirrored in `konusbitr_worker.parse.vlm.cost` — by the worker. The Python
 * half is hand-mirrored rather than generated because this never crosses the
 * Redis seam as a *message*; `test_vlm_cost.py` and `vlm.test.ts` hold the two
 * to the same numbers.
 *
 * **What an estimate is and is not.** It is an upper-ish bound computed from
 * the page count, the render resolution and a published per-token price. It is
 * not a quote: a provider's real tokenizer, a page that comes back with far
 * less structure than budgeted, and prompt caching all move the true number
 * downwards. It is presented to the reader as "up to", and the accounting that
 * bills is `konusbitr_worker.ai.usage`, which records what actually happened.
 */

// ─── Limits ──────────────────────────────────────────────────────────────────

/**
 * Pages of one document the advanced tier will read, before the job is refused.
 *
 * Fifty, which is roughly a long report and roughly where a frontier model's
 * per-page price stops being a rounding error. Documents past it fail at intake
 * with `too_many_pages` rather than half-way through, because a refusal after
 * thirty pages of inference has already spent the money it was meant to save.
 */
export const DEFAULT_MAX_VLM_PAGES_PER_JOB = 50;

/**
 * Page confidence below which the standard tier hands a page to the VLM.
 *
 * The phase's number. It sits well under `OCR_LOW_CONFIDENCE_THRESHOLD` (0.85,
 * where the viewer merely warns a reader) because this threshold spends money:
 * a page has to be genuinely badly read, not merely imperfect, before it is
 * worth a vision call. A page the recogniser is 0.6 confident about is one
 * where roughly two words in five are guesses.
 */
export const DEFAULT_TIER_FALLBACK_THRESHOLD = 0.6;

/** What a page is rendered at before it is shown to a vision model. */
export const DEFAULT_VLM_DPI = 180;

/**
 * Longest edge, in pixels, a page image is resampled to.
 *
 * Every frontier vision model downsamples above roughly this size anyway, so
 * sending more costs tokens and buys nothing. Fixing it here is also what makes
 * the estimate a function of the *page count* rather than of the page sizes: an
 * A0 poster and a Letter page cost the same to look at.
 */
export const VLM_IMAGE_MAX_EDGE = 1568;

// ─── The token model ─────────────────────────────────────────────────────────

/**
 * Square pixels per image token.
 *
 * Anthropic publishes `width × height / 750`; OpenAI's tiling and Google's
 * fixed-tile scheme land within about thirty percent of it for a page-shaped
 * image. One number across providers is the honest resolution of an estimate
 * that is shown as "up to" — a per-provider tiling model would be more precise
 * about a quantity whose real variance is the document, not the arithmetic.
 */
export const PIXELS_PER_IMAGE_TOKEN = 750;

/** The instruction turn: `vlm.parse.v1` plus the JSON schema it specifies. */
export const VLM_PROMPT_TOKENS = 420;

/**
 * Output tokens budgeted for one page.
 *
 * A dense page of structured elements — text, markdown and a box for each —
 * runs to roughly this. It is also the `max_tokens` the worker sends, so the
 * estimate cannot be beaten by a page that would have produced more: it would
 * be truncated instead.
 */
export const VLM_COMPLETION_TOKENS_PER_PAGE = 1500;

/** Wall-clock seconds one page's inference takes, for the latency estimate. */
export const VLM_SECONDS_PER_PAGE = 6;

/** How many pages the worker reads concurrently. Mirrors `_CONCURRENCY`. */
export const VLM_PAGE_CONCURRENCY = 3;

/**
 * Published prices, USD per million tokens, as `[prompt, completion]`.
 *
 * Keyed by the model name the router resolves, so the table is read with
 * exactly the string that will be billed. A model absent from it estimates
 * against {@link FALLBACK_PRICE} and the response says the price was a
 * fallback, because a confident `$0.00` for an unknown model is worse than an
 * admitted guess.
 *
 * These move. They are a default an operator overrides with
 * `VLM_USD_PER_PAGE`, and the response carries `pricedFrom` so a UI can say
 * where its number came from.
 */
export const VLM_MODEL_PRICES: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  'claude-sonnet-4-5': [3, 15],
  'claude-3-7-sonnet-latest': [3, 15],
  'claude-3-5-sonnet-latest': [3, 15],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1': [2, 8],
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gemini/gemini-2.5-flash': [0.3, 2.5],
  'gemini/gemini-2.0-flash': [0.1, 0.4],
  'pixtral-12b-2409': [0.15, 0.15],
});

/** What an unlisted cloud model is priced at. Deliberately not cheap. */
export const FALLBACK_PRICE: readonly [number, number] = [3, 15];

/**
 * The local vision model the offline path routes to.
 *
 * Named here rather than only in the environment contract because the
 * estimator has to know that it costs nothing: a self-hosted Qwen2.5-VL on the
 * operator's own GPU is electricity, not an invoice, and an estimate that
 * showed a dollar figure for it would be a lie in the direction that stops
 * people using the offline path.
 */
export const DEFAULT_LOCAL_VLM_MODEL = 'ollama/qwen2.5vl:7b';

// ─── Estimation ──────────────────────────────────────────────────────────────

export type VlmCostEstimate = {
  /** Pages that would actually be read by the VLM. */
  pages: number;
  promptTokens: number;
  completionTokens: number;
  /** `null` for a local model, which costs no money. */
  estimatedUsd: number | null;
  estimatedSeconds: number;
  /** Where `estimatedUsd` came from, so a UI can hedge honestly. */
  pricedFrom: 'table' | 'fallback' | 'operator' | 'local';
  model: string;
};

export type EstimateInput = {
  pageCount: number;
  /** The resolved vision model name, exactly as the router would call it. */
  model: string;
  provider: LlmProvider;
  dpi?: number;
  /** `VLM_USD_PER_PAGE`, when an operator has priced their own deployment. */
  usdPerPageOverride?: number | undefined;
};

/**
 * Image tokens for one page rendered at `dpi` and resampled to fit the cap.
 *
 * A Letter page is the unit because the cap, not the paper size, decides what a
 * model actually looks at. At the default 180 DPI a Letter page renders to
 * 1530 × 1980 and is already past {@link VLM_IMAGE_MAX_EDGE} on its long edge,
 * so it arrives resampled to 1211 × 1568 — and so does an A0 poster. Charging
 * for the render rather than for the resample would over-estimate every page by
 * a factor of 1.6, for pixels the provider discards before it looks.
 */
export function imageTokensPerPage(dpi: number = DEFAULT_VLM_DPI): number {
  const width = 8.5 * dpi;
  const height = 11 * dpi;
  const scale = Math.min(1, VLM_IMAGE_MAX_EDGE / Math.max(width, height));
  return Math.ceil((width * scale * (height * scale)) / PIXELS_PER_IMAGE_TOKEN);
}

/**
 * What reading `pageCount` pages with a vision model would cost.
 *
 * Pure arithmetic, no I/O, and mirrored exactly in the worker. The one piece of
 * policy in it is that a local provider is priced at `null` rather than at zero
 * — "no charge" and "we do not know" look the same as `0` and mean opposite
 * things to somebody deciding whether to press the button.
 */
export function estimateVlmCost(input: EstimateInput): VlmCostEstimate {
  const pages = Math.max(0, Math.trunc(input.pageCount));
  const perPageImage = imageTokensPerPage(input.dpi ?? DEFAULT_VLM_DPI);

  const promptTokens = pages * (perPageImage + VLM_PROMPT_TOKENS);
  const completionTokens = pages * VLM_COMPLETION_TOKENS_PER_PAGE;
  const estimatedSeconds = Math.ceil(
    (pages / Math.max(1, VLM_PAGE_CONCURRENCY)) * VLM_SECONDS_PER_PAGE,
  );

  if (isLocalProvider(input.provider)) {
    return {
      pages,
      promptTokens,
      completionTokens,
      estimatedUsd: null,
      estimatedSeconds,
      pricedFrom: 'local',
      model: input.model,
    };
  }

  if (input.usdPerPageOverride !== undefined && input.usdPerPageOverride >= 0) {
    return {
      pages,
      promptTokens,
      completionTokens,
      estimatedUsd: round6(pages * input.usdPerPageOverride),
      estimatedSeconds,
      pricedFrom: 'operator',
      model: input.model,
    };
  }

  const listed = VLM_MODEL_PRICES[input.model];
  const [promptPrice, completionPrice] = listed ?? FALLBACK_PRICE;
  const estimatedUsd = round6(
    (promptTokens / 1_000_000) * promptPrice + (completionTokens / 1_000_000) * completionPrice,
  );

  return {
    pages,
    promptTokens,
    completionTokens,
    estimatedUsd,
    estimatedSeconds,
    pricedFrom: listed ? 'table' : 'fallback',
    model: input.model,
  };
}

/** Six places, because a single cheap page really is fractions of a cent. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// ─── The endpoint contract ───────────────────────────────────────────────────

/**
 * `POST /api/documents/estimate-cost` — what would this cost, before I commit?
 *
 * Takes a page count rather than a file, deliberately. The browser knows how
 * many pages a PDF has before it uploads it, the answer does not depend on the
 * bytes, and an endpoint that needed the file would mean uploading a 400-page
 * document in order to be told it is too long.
 */
export const EstimateCostRequestSchema = z.object({
  pageCount: z.number().int().positive().max(100_000),
  quality: z.enum(['standard', 'advanced']).default('advanced'),
});

export type EstimateCostRequest = z.infer<typeof EstimateCostRequestSchema>;

export const EstimateCostResponseSchema = z.object({
  quality: z.enum(['standard', 'advanced']),
  pageCount: z.number().int().nonnegative(),
  /** True when this document may be submitted at the requested quality. */
  allowed: z.boolean(),
  /** Set when `allowed` is false: the same code the job would have failed with. */
  reason: z.enum(['too_many_pages', 'spend_cap_reached', 'not_configured']).nullable(),
  /** A sentence for a person, already written. */
  message: z.string(),
  maxPages: z.number().int().positive(),
  estimate: z.object({
    pages: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    estimatedUsd: z.number().nonnegative().nullable(),
    estimatedSeconds: z.number().int().nonnegative(),
    pricedFrom: z.enum(['table', 'fallback', 'operator', 'local']),
    model: z.string(),
  }),
  /** The organization's remaining monthly allowance, when one is configured. */
  spend: z
    .object({
      monthToDateUsd: z.number().nonnegative(),
      capUsd: z.number().nonnegative(),
      remainingUsd: z.number(),
    })
    .nullable(),
});

export type EstimateCostResponse = z.infer<typeof EstimateCostResponseSchema>;

/**
 * A USD figure as the confirmation modal shows it.
 *
 * Sub-cent amounts are given three decimals rather than rounded to `$0.00`,
 * because "this costs nothing measurable" and "we could not price it" must not
 * render identically — the second is the `null` case and says so in words.
 */
export function formatUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  if (value > 0) return `$${value.toFixed(3)}`;
  return '$0.00';
}
