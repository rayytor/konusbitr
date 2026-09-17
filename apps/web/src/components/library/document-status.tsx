import {
  BookOpen,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  CircleSlash,
  Loader,
  ScanLine,
  Sparkles,
} from 'lucide-react';
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
  // Named for what the reader can do rather than for what the pipeline is
  // doing. "Partly indexed" describes the machine; "Ready to read" is the
  // thing that changed for them — the viewer opens and chat answers.
  partially_ready: { label: 'Ready to read', icon: BookOpen, className: 'text-foreground-muted' },
  ready: { label: 'Ready', icon: CheckCircle2, className: 'text-success' },
  failed: { label: 'Failed', icon: CircleAlert, className: 'text-danger' },
  // Not `text-danger`. A reader who stopped their own upload is not looking at
  // a problem, and badging their own decision in red says otherwise.
  cancelled: { label: 'Stopped', icon: CircleSlash, className: 'text-foreground-muted' },
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
  cancelled: 'cancelled',
};

export function DocumentStatus({
  status,
  stage,
  percent,
  showProgressBar = false,
  className,
}: {
  status: string;
  /** A live stage from SSE, which wins over the row's status when present. */
  stage?: string;
  percent?: number;
  showProgressBar?: boolean;
  className?: string;
}) {
  const fromStage = stage === undefined ? undefined : STAGE_LABELS[stage];
  const resolved: KnownStatus = fromStage ?? (isKnown(status) ? status : 'queued');
  const entry = STATUSES[resolved];
  const Icon = entry.icon;

  // Shown only while something is actually happening: "Ready 100%" is noise,
  // and a percentage next to "Failed" reads as a bug.
  // `partially_ready` counts as working: pages are still arriving, and a
  // percentage next to "Ready to read" is the honest picture of a document
  // that can be read now and is not finished.
  const isWorking = resolved !== 'ready' && resolved !== 'failed' && resolved !== 'cancelled';
  const showPercent = percent !== undefined && isWorking && percent > 0;

  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-[13px]', entry.className, className)}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {entry.label}
      {showPercent ? <span className="tabular-nums">{Math.round(percent)}%</span> : null}
      {showProgressBar && isWorking ? (
        <progress
          max={100}
          value={percent !== undefined && percent > 0 ? percent : undefined}
          aria-label={`${entry.label} progress: ${percent !== undefined ? Math.round(percent) : 0}%`}
          className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-muted [&::-webkit-progress-bar]:bg-surface-muted [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent"
        />
      ) : null}
    </span>
  );
}
