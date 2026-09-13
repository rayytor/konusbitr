'use client';

import type { LucideIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * An icon-only control that cannot be built wrong.
 *
 * `design.md` §11 and §22 together require three things of every one of these:
 * an accessible name, a tooltip, and a touch target big enough to hit. Getting
 * two of the three is easy and useless, so this component takes the label once
 * and produces all three from it.
 */
export function IconButton({
  icon: Icon,
  label,
  side = 'bottom',
  className,
  active = false,
  ...props
}: Omit<ComponentProps<typeof Button>, 'children' | 'size'> & {
  icon: LucideIcon;
  label: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** A toggle that is currently on. Announced, not merely shaded. */
  active?: boolean;
}) {
  return (
    <Tooltip label={label} side={side}>
      <Button
        {...props}
        size="icon"
        aria-label={label}
        aria-pressed={props.variant === undefined && active ? true : undefined}
        className={cn(active ? 'bg-surface-muted text-foreground' : '', className)}
      >
        <Icon aria-hidden />
      </Button>
    </Tooltip>
  );
}
