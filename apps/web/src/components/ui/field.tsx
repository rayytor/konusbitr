import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Form primitives, per `design.md` §15: quiet surfaces, subtle borders,
 * comfortable padding, and a focus state that is impossible to miss.
 *
 * `Field` exists so that a label, a control, a hint and an error are always
 * wired together — `htmlFor`, `aria-describedby` and `aria-invalid` are easy to
 * forget one at a time and the specification treats them as mandatory.
 */

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-[var(--radius-sm)] border border-border bg-surface px-3',
        'text-[15px] text-foreground placeholder:text-foreground-subtle',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-accent',
        'disabled:opacity-60',
        'aria-[invalid=true]:border-danger',
        className,
      )}
      {...props}
    />
  );
}

export type FieldProps = {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: (aria: {
    id: string;
    'aria-describedby': string;
    'aria-invalid': boolean;
  }) => ReactNode;
};

export function Field({ id, label, hint, error, children }: FieldProps) {
  const describedBy = `${id}-description`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[15px] text-foreground-muted">
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': Boolean(error) })}
      <p
        id={describedBy}
        className={cn('text-[13px]', error ? 'text-danger' : 'text-foreground-subtle')}
      >
        {/* One node for both states so a screen reader reading the description
            hears the error in the same place it heard the hint. */}
        {error ?? hint}
      </p>
    </div>
  );
}
