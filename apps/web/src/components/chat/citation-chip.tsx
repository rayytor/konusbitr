'use client';

import type { Citation } from '@konusbitr/shared';
import { useId, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * A page reference inside an answer.
 *
 * `design.md` §8 shows this as `[p. 42]` — compact, obviously clickable, and
 * connected to the document rather than decorating the sentence. The hover
 * preview is the quote itself, which matters more than it looks: a citation the
 * reader can check without leaving their place in the answer is the difference
 * between a footnote and a promise.
 *
 * It is a real `<button>`, so it is in the tab order, and the preview opens on
 * focus as well as hover — a keyboard reader must be able to check a quote too.
 * Nothing about it animates on hover; the preview appearing is a state change.
 */
export function CitationChip({
  citation,
  active,
  onSelect,
}: {
  citation: Citation;
  active: boolean;
  onSelect: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-block align-baseline">
      <button
        type="button"
        onClick={onSelect}
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
        aria-describedby={open ? id : undefined}
        aria-label={`Show page ${citation.page} in the document`}
        className={cn(
          'mx-0.5 inline-flex cursor-pointer items-baseline rounded-[4px] border px-1.5 py-px',
          'align-baseline font-sans text-[13px] leading-normal tabular-nums',
          active
            ? 'border-highlight-active bg-highlight-active text-foreground'
            : 'border-border bg-surface-muted text-accent-contrast',
        )}
      >
        p.&nbsp;{citation.page}
      </button>

      {open ? (
        <span
          role="tooltip"
          id={id}
          className={cn(
            'kb-fade-in absolute bottom-full left-1/2 z-40 mb-2 w-72 -translate-x-1/2',
            'rounded-[var(--radius-md)] border border-border-subtle bg-surface p-3 shadow-lg',
          )}
        >
          <span className="block font-serif text-[15px] leading-relaxed text-foreground">
            “{citation.quote}”
          </span>
          <span className="mt-2 block text-[13px] text-foreground-subtle">
            Page {citation.page} · verified against the document
          </span>
        </span>
      ) : null}
    </span>
  );
}
