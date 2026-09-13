import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * Buttons, per `design.md` §10.
 *
 * Note what is absent: there is no `transition`, no `scale`, no `translate`.
 * Hover changes the surface immediately or not at all — animating an
 * interactive element on hover is one of the specification's non-negotiable
 * rules, and the cheapest place to break it is a button variant.
 *
 * Focus is the exception that must stay loud: a visible ring in every variant,
 * because minimalism is never traded against keyboard use.
 */
const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-sm)]',
    'text-[15px] font-normal cursor-pointer select-none',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:size-4 [&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-[#3a352d]',
        secondary: 'bg-surface text-foreground border border-border hover:bg-surface-muted',
        tertiary: 'bg-transparent text-foreground-muted hover:text-foreground',
        danger: 'bg-transparent text-danger border border-border hover:bg-surface-muted',
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-10 px-4',
        icon: 'h-9 w-9 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
