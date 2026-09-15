import { scopedDb } from '@konusbitr/db';
import {
  DEFAULT_VISION_MODELS,
  type Env,
  type EstimateCostResponse,
  estimateVlmCost,
  formatUsd,
  isRoleConfigured,
  type ParseSettings,
  roleModel,
  roleProvider,
  type VlmCostEstimate,
} from '@konusbitr/shared';
import { db } from '../db';
import { IngestError } from './errors';

/**
 * The advanced tier's guardrails, on the side of the seam a person can see.
 *
 * Phase 12.3 adds a parse path whose cost scales with page count times a
 * provider's token price, and the whole of the guardrail design is that a
 * refusal must arrive **before** the money is spent. There are three of them
 * and they are enforced here, at intake, where the answer is an HTTP status
 * that a browser can turn into a sentence:
 *
 * 1. **Not configured.** `quality: "advanced"` with no vision role is a request
 *    that cannot be honoured, and saying so is better than silently parsing at
 *    standard quality under an `advanced` settings hash — which would poison
 *    the docId cache with a standard parse that a later, properly-configured
 *    upload would then be handed.
 * 2. **Too many pages.** Above `MAX_VLM_PAGES_PER_JOB`, refused with
 *    `too_many_pages`, the same code the worker would have failed the job with.
 * 3. **Over the monthly cap.** When `ORG_MONTHLY_VLM_USD_CAP` is set and this
 *    document's estimate would cross it.
 *
 * The worker re-checks the page ceiling, because a job payload arrives from a
 * queue and not from the endpoint that validated it. It does not re-check the
 * other two: one is about configuration it can see for itself, and the other is
 * a billing decision that belongs where the ledger is.
 */

/** The ledger `reason` advanced-parse estimates are recorded under. */
export const VLM_SPEND_REASON = 'vlm_parse';

export type VisionRole = {
  /** The model name the router would resolve, exactly as it would be billed. */
  model: string;
  provider: ReturnType<typeof roleProvider>;
  /** False when no vision model is configured, which is the default `.env`. */
  configured: boolean;
};

/**
 * What the vision role resolves to, without calling anything.
 *
 * Mirrors `resolve_vision_model` in the worker minus the side effects: the same
 * provider fallback chain, the same default-model table. It has to agree,
 * because the price quoted here is the price of the model that will actually
 * run — quoting `gpt-4.1-mini` and running `claude-sonnet-4-5` is a bill an
 * operator did not approve.
 */
export function visionRole(env: Env): VisionRole {
  const provider = roleProvider(env, 'vision');
  const model = roleModel(env, 'vision') ?? DEFAULT_VISION_MODELS[provider] ?? '';
  return {
    model,
    provider,
    configured: model !== '' && isRoleConfigured(env, 'vision'),
  };
}

/** What an advanced parse of `pageCount` pages would cost on this deployment. */
export function estimateFor(env: Env, pageCount: number): VlmCostEstimate {
  const role = visionRole(env);
  return estimateVlmCost({
    pageCount,
    model: role.model,
    provider: role.provider,
    dpi: env.VLM_DPI,
    usdPerPageOverride: env.VLM_USD_PER_PAGE,
  });
}

export type Allowance = {
  allowed: boolean;
  reason: EstimateCostResponse['reason'];
  message: string;
  estimate: VlmCostEstimate;
  spend: EstimateCostResponse['spend'];
};

/**
 * Decide whether this organization may parse a document of this length.
 *
 * Returns the verdict rather than throwing, because the same computation serves
 * two callers with opposite needs: `POST /api/documents/estimate-cost` renders
 * it as a modal, and the intake path raises it as a 4xx. {@link assertAllowed}
 * is the second.
 */
export async function checkAllowance(
  orgId: string,
  env: Env,
  pageCount: number,
): Promise<Allowance> {
  const estimate = estimateFor(env, pageCount);
  const role = visionRole(env);
  const cap = env.ORG_MONTHLY_VLM_USD_CAP;

  const spend =
    cap > 0
      ? await (async () => {
          const monthToDateUsd = await scopedDb(db(), orgId).vlmSpendThisMonth(VLM_SPEND_REASON);
          return {
            monthToDateUsd,
            capUsd: cap,
            remainingUsd: Math.max(0, cap - monthToDateUsd),
          };
        })()
      : null;

  if (!env.VLM_ENABLED || !role.configured) {
    return {
      allowed: false,
      reason: 'not_configured',
      message: env.VLM_ENABLED
        ? 'Advanced parsing needs a vision model. Set VISION_PROVIDER and VISION_MODEL, or upload at standard quality.'
        : 'Advanced parsing is switched off on this instance.',
      estimate,
      spend,
    };
  }

  if (pageCount > env.MAX_VLM_PAGES_PER_JOB) {
    return {
      allowed: false,
      reason: 'too_many_pages',
      message: `That document has ${pageCount} pages, and the advanced parser reads at most ${env.MAX_VLM_PAGES_PER_JOB} in one job. Parse it at standard quality, or split it into shorter documents.`,
      estimate,
      spend,
    };
  }

  if (
    spend !== null &&
    estimate.estimatedUsd !== null &&
    estimate.estimatedUsd > spend.remainingUsd
  ) {
    return {
      allowed: false,
      reason: 'spend_cap_reached',
      message: `This organization has ${formatUsd(spend.remainingUsd)} of its ${formatUsd(spend.capUsd)} monthly advanced-parsing allowance left, and this document would cost about ${formatUsd(estimate.estimatedUsd)}.`,
      estimate,
      spend,
    };
  }

  return {
    allowed: true,
    reason: null,
    message:
      estimate.estimatedUsd === null
        ? `About ${estimate.estimatedSeconds}s on this deployment's own hardware, at no per-page cost.`
        : `About ${formatUsd(estimate.estimatedUsd)} and ${estimate.estimatedSeconds}s for ${estimate.pages} pages.`,
    estimate,
    spend,
  };
}

/**
 * Refuse an advanced upload the guardrails do not permit. A no-op otherwise.
 *
 * `pageCount` is `null` for a PDF that hides its page objects inside an object
 * stream — the intake scanner reads structure without decompressing, which is
 * what lets it validate a 200MB file in one streaming pass. Such a document is
 * **let through**, and the worker's own ceiling catches it after PDFium has
 * opened the file properly. Guessing high here would refuse perfectly ordinary
 * documents; guessing low would defeat the guardrail. Deferring to the side
 * that actually knows is the only honest third option.
 */
export async function assertAllowed(
  orgId: string,
  env: Env,
  settings: ParseSettings,
  pageCount: number | null,
): Promise<void> {
  if (settings.quality !== 'advanced') return;

  const allowance = await checkAllowance(orgId, env, pageCount ?? 0);
  if (allowance.allowed) return;
  if (allowance.reason === 'too_many_pages' && pageCount === null) return;

  throw new IngestError(
    allowance.reason === 'too_many_pages' ? 413 : 422,
    allowance.reason ?? 'advanced_unavailable',
    allowance.message,
  );
}

/**
 * Record what an advanced parse is expected to cost, against the monthly cap.
 *
 * Written when the job is created rather than when it finishes, because that is
 * the moment at which the number can still prevent a spend. It goes in the
 * credit ledger with a zero `delta` — no credits change hands; the estimate
 * lives in `metadata`, which is what {@link checkAllowance} sums. A row per
 * advanced document is also the audit trail an operator wants when they ask why
 * this month's allowance is gone.
 */
export async function recordEstimate(
  orgId: string,
  documentId: string,
  estimate: VlmCostEstimate,
): Promise<void> {
  await scopedDb(db(), orgId).recordCredit({
    delta: 0,
    reason: VLM_SPEND_REASON,
    refId: documentId,
    metadata: {
      estimatedUsd: estimate.estimatedUsd ?? 0,
      pages: estimate.pages,
      model: estimate.model,
      pricedFrom: estimate.pricedFrom,
    },
  });
}
