import { CheckCircle2, CircleAlert, CircleDashed, Loader, ScanLine, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * What is happening to a document, in an icon and a word.
 *
 * Both, always. `design.md` §24 forbids communicating state by colour alone,
 * and a library where "failed" is distinguishable from "ready" only by a shade
 * of red is exactly the failure that rule exists to prevent — so the icon
 * carries the meaning and the colour only reinforces it.
 */
const STATUSES = {
  queued: { label: 'Queued', icon: CircleDashed, className: 'text-foreground-muted' },
  parsing: { label: 'Parsing', icon: Loader, className: 'text-foreground-muted' },
  ocr: { label: 'Reading text', icon: ScanLine, className: 'text-foreground-muted' },
  embedding: { label: 'Indexing', icon: Sparkles, className: 'text-foreground-muted' },
  ready: { label: 'Ready', icon: CheckCircle2, className: 'text-success' },
  failed: { label: 'Failed', icon: CircleAlert, className: 'text-danger' },
} as const;

type KnownStatus = keyof typeof STATUSES;

function isKnown(status: string): status is KnownStatus {
  return status in STATUSES;
}

/**
 * The stages the worker reports, mapped onto the same six words.
 *
 * The pipeline is finer-grained than the status column — `fetching`,
 * `validating` and `parsing` are one thing to someone watching a spinner — and
 * this is where that collapse happens, so a live progress frame and a row read
 * from the database render identically.
 */
const STAGE_LABELS: Record<string, KnownStatus> = {
  queued: 'queued',
  fetching: 'parsing',
  validating: 'parsing',
  parsing: 'parsing',
  ocr: 'ocr',
  chunking: 'embedding',
  embedding: 'embedding',
  persisting: 'embedding',
  ready: 'ready',
  failed: 'failed',
};

export function DocumentStatus({
  status,
  stage,
  percent,
  className,
}: {
  status: string;
  /** A live stage from SSE, which wins over the row's status when present. */
  stage?: string;
  percent?: number;
  className?: string;
}) {
  const fromStage = stage === undefined ? undefined : STAGE_LABELS[stage];
  const resolved: KnownStatus = fromStage ?? (isKnown(status) ? status : 'queued');
  const entry = STATUSES[resolved];
  const Icon = entry.icon;

  // Shown only while something is actually happening: "Ready 100%" is noise,
  // and a percentage next to "Failed" reads as a bug.
  const showPercent =
    percent !== undefined && resolved !== 'ready' && resolved !== 'failed' && percent > 0;

  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-[12px]', entry.className, className)}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {entry.label}
      {showPercent ? <span className="tabular-nums">{Math.round(percent)}%</span> : null}
    </span>
  );
}
