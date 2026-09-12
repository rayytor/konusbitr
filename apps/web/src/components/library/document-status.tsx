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

export function DocumentStatus({ status, className }: { status: string; className?: string }) {
  const entry = isKnown(status) ? STATUSES[status] : STATUSES.queued;
  const Icon = entry.icon;

  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-[12px]', entry.className, className)}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {entry.label}
    </span>
  );
}
