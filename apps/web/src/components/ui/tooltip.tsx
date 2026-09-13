'use client';

import { cloneElement, type ReactElement, type ReactNode, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * A label for a control whose icon might not be enough.
 *
 * `design.md` §11 requires one on every icon-only control, and §22 requires it
 * to be reachable without a mouse — so this opens on focus as well as hover,
 * closes on Escape, and is wired with `aria-describedby` rather than `title`
 * (which no screen reader announces reliably and no keyboard user can reach).
 *
 * The trigger keeps its own accessible *name* from `aria-label`; the tooltip is
 * a description. Both matter: the name is what a screen reader says when focus
 * lands, the description is the extra sentence a sighted user gets on hover.
 *
 * Appearing is a state change, not a hover effect — the delay and the fade are
 * §19 motion, and nothing about the trigger itself animates.
 */
export function Tooltip({
  label,
  side = 'bottom',
  children,
}: {
  label: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactElement<{
    'aria-describedby'?: string;
    onPointerEnter?: (event: React.PointerEvent) => void;
    onPointerLeave?: (event: React.PointerEvent) => void;
    onFocus?: (event: React.FocusEvent) => void;
    onBlur?: (event: React.FocusEvent) => void;
    onKeyDown?: (event: React.KeyboardEvent) => void;
  }>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  function show(delay: number) {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  }

  function hide() {
    clearTimeout(timer.current);
    setOpen(false);
  }

  const positions = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  } as const;

  return (
    <span className="relative inline-flex">
      {cloneElement(children, {
        'aria-describedby': open ? id : undefined,
        onPointerEnter: () => show(350),
        onPointerLeave: hide,
        // Keyboard focus gets the tooltip immediately: a user who tabbed here
        // is asking what this control is, not passing over it.
        onFocus: () => show(0),
        onBlur: hide,
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === 'Escape') hide();
          children.props.onKeyDown?.(event);
        },
      })}
      {open ? (
        <span
          role="tooltip"
          id={id}
          className={cn(
            'kb-fade-in pointer-events-none absolute z-50 whitespace-nowrap',
            'rounded-[var(--radius-sm)] border border-border-subtle bg-surface px-2 py-1',
            'text-[13px] text-foreground-muted shadow-sm',
            positions[side],
          )}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
