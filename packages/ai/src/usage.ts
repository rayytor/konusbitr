import type { LlmProvider, ModelRole } from '@konusbitr/shared';

/**
 * Token and cost accounting, emitted once per model call.
 *
 * Phase 15 points this at Langfuse; Phase 13 bills on it. Both of those need
 * the same record, which is why it is collected from the start rather than
 * added when something consumes it: a usage series that begins the day
 * observability ships is a usage series with no history to compare against.
 *
 * What is deliberately *not* here: any of the text. A usage record is written
 * to logs an operator reads and shipped to a third-party observability
 * platform, and document text is untrusted input that must reach neither. So
 * the record carries counts and identifiers, and the closest it comes to
 * content is how many items were in the batch.
 */
export type UsageRecord = {
  role: ModelRole;
  provider: LlmProvider;
  model: string;
  /** Items in this call: passages embedded, messages sent, documents reranked. */
  items: number;
  promptTokens: number;
  completionTokens: number;
  /** Wall clock for the call, retries included. */
  durationMs: number;
  /** Attempts spent, the first included. */
  attempts: number;
  /**
   * Estimated cost in USD, or `null` when the model has no published price —
   * which is every local model, where the honest answer is "no marginal cost"
   * rather than zero dollars of a metered spend.
   */
  costUsd: number | null;
};

export type UsageSink = (record: UsageRecord) => void;

/**
 * Published prices, in USD per million tokens.
 *
 * A small hand-maintained table rather than a dependency: it covers the models
 * `DEFAULT_*_MODELS` names, it is only ever an estimate for a dashboard, and a
 * package that tracks provider pricing is a package that has to be updated on
 * somebody else's release schedule. A model that is not here reports `null`,
 * which renders as "unpriced" rather than as free.
 */
const PRICE_PER_MILLION_TOKENS: Readonly<Record<string, { input: number; output: number }>> =
  Object.freeze({
    'text-embedding-3-large': { input: 0.13, output: 0 },
    'text-embedding-3-small': { input: 0.02, output: 0 },
    'mistral-embed': { input: 0.1, output: 0 },
  });

export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const price = PRICE_PER_MILLION_TOKENS[model];
  if (price === undefined) return null;
  return (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
}

/**
 * The default sink: one structured line per call.
 *
 * `console` rather than a logger dependency, because this package is imported
 * by both the Next.js server and the scripts in `evals/`, and neither should
 * inherit a logging framework from a model router.
 */
export const logUsage: UsageSink = (record) => {
  // biome-ignore lint/suspicious/noConsole: emitting is this sink's only job
  console.info('[ai] model call', record);
};

/** Collect records instead of emitting them. Used by tests and by the evals. */
export function collectUsage(): { sink: UsageSink; records: UsageRecord[] } {
  const records: UsageRecord[] = [];
  return { sink: (record) => void records.push(record), records };
}
