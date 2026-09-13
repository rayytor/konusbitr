'use client';

import type { LucideIcon } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '@/lib/utils';

export type MenuItem = {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  /** Rendered in the danger colour *and* under a divider, never colour alone. */
  destructive?: boolean;
  disabled?: boolean;
  /** A keyboard hint, shown right-aligned. Purely informational. */
  shortcut?: string;
};

/**
 * A dropdown menu, built to the WAI-ARIA menu-button pattern.
 *
 * Hand-rolled rather than pulled in, for one reason that matters here: every
 * off-the-shelf menu ships hover and open animations that `design.md` §20
 * forbids, and stripping them back out is more code than this. What it does
 * implement is the part that is actually hard — roving focus with the arrow
 * keys, Home/End, typeahead-free Escape handling, focus returned to the
 * trigger on close, and an outside click that closes without swallowing the
 * click that caused it.
 */
export function Menu({
  trigger,
  items,
  align = 'end',
  label,
}: {
  trigger: (props: {
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    'aria-controls': string;
    onClick: () => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
    ref: React.Ref<HTMLButtonElement>;
  }) => ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end';
  label: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const enabled = items.filter((item) => !item.disabled);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    }

    // Closing on scroll rather than repositioning: an absolutely-positioned
    // menu that follows its trigger through a virtualized list is a source of
    // jitter, and a menu that outlives the row it belongs to is worse.
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', () => setOpen(false), { once: true });
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const node = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[active];
    node?.focus();
  }, [open, active]);

  function onMenuKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      close(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current + delta + enabled.length) % enabled.length);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActive(enabled.length - 1);
    }
  }

  return (
    <span className="relative inline-flex">
      {trigger({
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': id,
        ref: triggerRef,
        onClick: () => {
          setActive(0);
          setOpen((current) => !current);
        },
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive(0);
            setOpen(true);
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(Math.max(0, enabled.length - 1));
            setOpen(true);
          }
        },
      })}

      {open ? (
        <div
          ref={menuRef}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className={cn(
            'kb-menu-enter absolute top-full z-40 mt-1 min-w-48 overflow-hidden py-1',
            'rounded-[var(--radius-md)] border border-border-subtle bg-surface shadow-lg',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {enabled.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                tabIndex={index === active ? 0 : -1}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
                onPointerEnter={() => setActive(index)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-[15px]',
                  'focus-visible:outline-none',
                  item.destructive
                    ? 'text-danger hover:bg-surface-muted focus:bg-surface-muted'
                    : 'text-foreground hover:bg-surface-muted focus:bg-surface-muted',
                  // A divider above the first destructive item, so "delete" is
                  // separated by structure and not only by colour.
                  item.destructive && index > 0 ? 'mt-1 border-t border-border-subtle pt-2' : '',
                )}
              >
                {Icon ? <Icon aria-hidden className="size-3.5 shrink-0" /> : null}
                <span className="flex-1 truncate">{item.label}</span>
                {item.shortcut ? (
                  <kbd className="font-sans text-[13px] text-foreground-subtle">
                    {item.shortcut}
                  </kbd>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}
