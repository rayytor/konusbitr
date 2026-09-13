import { cn } from '@/lib/utils';

/**
 * A placeholder for content whose shape is known before its value is.
 *
 * Deliberately still. `design.md` §18 asks for skeletons and then rules out
 * "excessive pulsing"; a shimmer across a library of forty rows is exactly the
 * decorative animation the specification is arguing against, and a quiet block
 * of the muted surface reads as "loading" without any of it.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('block rounded-[var(--radius-sm)] bg-surface-muted', className)}
    />
  );
}
