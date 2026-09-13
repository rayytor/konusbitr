'use client';

import type { LucideIcon } from 'lucide-react';
import { useId } from 'react';
import { cn } from '@/lib/utils';

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: LucideIcon;
};

/**
 * A small exclusive choice — list or grid, light or dark.
 *
 * A real radio group rather than a row of buttons, so the arrow keys move
 * between options and a screen reader announces "2 of 3" instead of reading
 * three unrelated controls. The selected option is marked by surface *and* by
 * `aria-checked`, never by colour alone.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  iconOnly = false,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  label: string;
  iconOnly?: boolean;
}) {
  const name = useId();

  function onKeyDown(event: React.KeyboardEvent, index: number) {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = options[(index + delta + options.length) % options.length];
    if (next) onChange(next.value);
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-[var(--radius-sm)] border border-border-subtle bg-surface p-0.5"
    >
      {options.map((option, index) => {
        const Icon = option.icon;
        const selected = option.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: real radio inputs cannot carry an icon and a surface treatment without a wrapping label per option; role="radio" with a roving tabIndex is the documented alternative and announces identically.
          <button
            key={option.value}
            type="button"
            role="radio"
            name={name}
            aria-checked={selected}
            aria-label={iconOnly ? option.label : undefined}
            title={iconOnly ? option.label : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'flex cursor-pointer items-center gap-1.5 rounded-[4px] px-2 py-1 text-[15px]',
              selected
                ? 'bg-surface-muted text-foreground'
                : 'text-foreground-muted hover:text-foreground',
            )}
          >
            {Icon ? <Icon aria-hidden className="size-3.5" /> : null}
            {iconOnly ? null : option.label}
          </button>
        );
      })}
    </div>
  );
}
