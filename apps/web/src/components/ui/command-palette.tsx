'use client';

import type { LucideIcon } from 'lucide-react';
import { Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export type Command = {
  id: string;
  label: string;
  hint?: string;
  icon?: LucideIcon;
  shortcut?: string;
  run: () => void;
  /** Extra words this command should match on, beyond its label. */
  keywords?: string;
};

/**
 * ⌘K.
 *
 * A combobox, built to the ARIA pattern rather than to the visual convention:
 * the input keeps focus and owns `aria-activedescendant`, the list is a
 * `listbox`, and the arrow keys move the selection without moving focus. That
 * is what makes it usable with a screen reader, which the pile of divs most
 * command palettes ship as is not.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return commands;
    return commands.filter((command) =>
      `${command.label} ${command.hint ?? ''} ${command.keywords ?? ''}`
        .toLowerCase()
        .includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setActive(0);
    input.current?.focus();
    return () => restoreTo.current?.focus();
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query means a new list, and the selection belongs at the top of it.
  useEffect(() => setActive(0), [query]);

  if (!open) return null;

  const chosen = matches[active];

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the scrim dismisses; Escape does the same and is the keyboard path.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[rgb(41_37_31_/_0.4)] p-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          'kb-dialog-enter w-full max-w-lg overflow-hidden rounded-[var(--radius-lg)]',
          'border border-border-subtle bg-surface shadow-xl',
        )}
      >
        <div className="flex items-center gap-2.5 border-b border-border-subtle px-4 py-3">
          <Search aria-hidden className="size-4 shrink-0 text-foreground-subtle" />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={chosen ? `${listId}-${chosen.id}` : undefined}
            aria-label="Search commands"
            placeholder="Search commands"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((current) => (current + 1) % Math.max(matches.length, 1));
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive(
                  (current) => (current - 1 + matches.length) % Math.max(matches.length, 1),
                );
              }
              if (event.key === 'Enter' && chosen) {
                event.preventDefault();
                onClose();
                chosen.run();
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-foreground-subtle focus-visible:outline-none"
          />
        </div>

        <ul
          id={listId}
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a combobox's popup is a listbox, and a <ul> of <li role="option"> is the markup the ARIA pattern prescribes.
          role="listbox"
          aria-label="Commands"
          className="max-h-80 overflow-y-auto py-1"
        >
          {matches.length === 0 ? (
            <li className="px-4 py-6 text-center text-[15px] text-foreground-subtle">
              No matching command.
            </li>
          ) : (
            matches.map((command, index) => {
              const Icon = command.icon;
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox is driven from the input's key handler, which is the ARIA combobox pattern.
                // biome-ignore lint/a11y/useFocusableInteractive: options must not be focusable — focus stays in the input, and aria-activedescendant points here.
                <li
                  key={command.id}
                  id={`${listId}-${command.id}`}
                  // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: an <li role="option"> inside a <ul role="listbox"> is the prescribed markup.
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => {
                    onClose();
                    command.run();
                  }}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 px-4 py-2 text-[15px]',
                    index === active ? 'bg-surface-muted' : '',
                  )}
                >
                  {Icon ? (
                    <Icon aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
                  ) : null}
                  <span className="flex-1 truncate">{command.label}</span>
                  {command.hint ? (
                    <span className="truncate text-[13px] text-foreground-subtle">
                      {command.hint}
                    </span>
                  ) : null}
                  {command.shortcut ? (
                    <kbd className="font-sans text-[13px] text-foreground-subtle">
                      {command.shortcut}
                    </kbd>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
