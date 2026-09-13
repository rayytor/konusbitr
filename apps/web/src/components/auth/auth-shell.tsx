import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandIcon } from '@/components/brand-icon';

/**
 * The frame around every unauthenticated page.
 *
 * Deliberately not a card. `design.md` asks for hierarchy from typography and
 * whitespace rather than from borders and shadows, so the form simply sits on
 * the page under an Instrument Serif title.
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
  headerAction,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  headerAction?: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-16">
      <div className="flex items-center justify-between">
        <Link
          href="/"
          className="flex items-center gap-2 text-[15px] text-foreground-subtle hover:text-foreground"
        >
          <BrandIcon className="size-4.5" />
          <span>Konusbitr</span>
        </Link>
        {headerAction}
      </div>

      <h1 className="mt-8 font-serif text-[30px] leading-tight tracking-tight">{title}</h1>
      {description ? (
        <p className="mt-2 text-[15px] leading-relaxed text-foreground-muted">{description}</p>
      ) : null}

      <div className="mt-8">{children}</div>

      {footer ? <div className="mt-8 text-[15px] text-foreground-muted">{footer}</div> : null}
    </main>
  );
}
