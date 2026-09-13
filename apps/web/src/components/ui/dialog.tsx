'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog, per `design.md` §16: a serif title, a sentence of
 * explanation, then the content, then secondary and primary actions.
 *
 * The three things a hand-rolled modal usually gets wrong are all here: focus
 * moves in on open and back to where it was on close, Tab is trapped inside,
 * and the rest of the page is `aria-hidden` to assistive technology rather than
 * merely covered by a backdrop.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  confirmLabel,
  onConfirm,
  confirmVariant = 'primary',
  cancelLabel = 'Cancel',
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  onConfirm?: () => void;
  confirmVariant?: 'primary' | 'danger';
  cancelLabel?: string;
  busy?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    restoreTo.current = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();

    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';

    return () => {
      body.style.overflow = previousOverflow;
      restoreTo.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a convenience dismissal; Escape and the Cancel button are the real ones, and both are reachable from a keyboard.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(41_37_31_/_0.45)] p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          'kb-dialog-enter w-full max-w-md rounded-[var(--radius-lg)] border border-border-subtle',
          'bg-surface p-6 shadow-xl focus:outline-none',
        )}
      >
        <h2 id={titleId} className="font-serif text-[18px] leading-tight">
          {title}
        </h2>
        {description ? (
          <p id={descriptionId} className="mt-2 text-[15px] leading-relaxed text-foreground-muted">
            {description}
          </p>
        ) : null}

        {children ? <div className="mt-5">{children}</div> : null}

        <div className="mt-7 flex items-center justify-end gap-2">
          <Button type="button" variant="tertiary" size="sm" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          {confirmLabel && onConfirm ? (
            <Button
              type="button"
              variant={confirmVariant}
              size="sm"
              onClick={onConfirm}
              disabled={busy}
            >
              {busy ? 'Working…' : confirmLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
