'use client';

import { type EstimateCostResponse, formatUsd } from '@konusbitr/shared';
import { Dialog } from '@/components/ui/dialog';

/**
 * "This will cost about ninety cents. Go ahead?"
 *
 * The advanced parser reads every page with a vision model, and unlike every
 * other operation in Konusbitr its cost is a bill somebody receives rather than
 * CPU time on a machine they already own. `design.md` §16 gives the shape — a
 * serif title, a sentence, the content, then cancel and confirm — and the
 * content here is deliberately four plain rows rather than a chart: a person
 * deciding whether to spend money wants the number, not a visualization of it.
 *
 * Three rules this dialog follows and the reason for each:
 *
 * **The price is always hedged in words, never only in digits.** The estimate
 * is arithmetic over a published per-token price and a budgeted page; the real
 * figure lands lower. "About" is doing real work.
 *
 * **A local model shows no price at all**, and says why. Rendering `$0.00` for
 * a self-hosted Qwen on the operator's own GPU would read as "we could not work
 * it out", which is the opposite of the truth.
 *
 * **A refusal is shown here rather than after the upload.** When the document
 * is too long or the month's allowance is spent, the confirm button is gone —
 * not disabled with a tooltip — and the reason is the sentence the server
 * wrote. There is nothing to press, which is the honest UI for "this cannot
 * happen".
 */
export function AdvancedConfirm({
  open,
  estimate,
  filename,
  worstCase = false,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** `null` while the estimate is in flight. */
  estimate: EstimateCostResponse | null;
  filename: string;
  /**
   * True when the page count is not known — a URL import, where the file is on
   * somebody else's server. The figures are then the *ceiling*, and every row
   * that shows one says so rather than reading as a measurement.
   */
  worstCase?: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const allowed = estimate?.allowed ?? false;

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="Parse with the advanced reader"
      description={
        <>
          The advanced reader looks at every page of{' '}
          <span className="break-all text-foreground">{filename}</span> with a vision model, which
          recovers reading order and headings on layouts the standard reader flattens. It costs
          money per page.
        </>
      }
      cancelLabel={allowed ? 'Cancel' : 'Close'}
      {...(allowed ? { confirmLabel: 'Parse it', onConfirm } : {})}
      busy={pending}
    >
      {estimate === null ? (
        <p className="text-[15px] text-foreground-muted">Working out what that would cost…</p>
      ) : (
        <dl className="flex flex-col gap-2 text-[15px]">
          <Row label="Pages">{worstCase ? `up to ${estimate.pageCount}` : estimate.pageCount}</Row>
          <Row label="Model">
            <span className="font-mono text-[13px]">{estimate.estimate.model || 'none'}</span>
          </Row>
          <Row label="Estimated cost">
            {estimate.estimate.estimatedUsd === null ? (
              <span className="text-foreground-muted">
                no per-page cost — this deployment runs its own model
              </span>
            ) : (
              <>
                {worstCase ? 'at most ' : 'about '}
                {formatUsd(estimate.estimate.estimatedUsd)}
                {estimate.estimate.pricedFrom === 'fallback' ? (
                  <span className="text-foreground-subtle">
                    {' '}
                    — priced against a default rate, not this model's published one
                  </span>
                ) : null}
              </>
            )}
          </Row>
          <Row label="Estimated time">
            about {formatSeconds(estimate.estimate.estimatedSeconds)}
          </Row>
          {estimate.spend ? (
            <Row label="Left this month">
              {formatUsd(estimate.spend.remainingUsd)} of {formatUsd(estimate.spend.capUsd)}
            </Row>
          ) : null}
          {/* Never colour alone: the refusal is a sentence, and the missing
              confirm button is the other half of saying it. */}
          {worstCase ? (
            <p className="mt-1 text-[15px] text-foreground-subtle">
              Konusbitr has not fetched this file yet, so these are the most it could cost. A
              shorter document costs proportionally less, and one longer than the page limit is
              refused before anything is spent.
            </p>
          ) : null}
          {!estimate.allowed ? (
            <p className="mt-1 text-[15px] text-danger">{estimate.message}</p>
          ) : null}
        </dl>
      )}
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-border-subtle border-b pb-2 last:border-0">
      <dt className="shrink-0 text-foreground-subtle">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function formatSeconds(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}
