import Link from 'next/link';
import type { ReactNode } from 'react';

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
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-16">
      <Link href="/" className="text-[13px] text-foreground-subtle">
        Konusbitr
      </Link>

      <h1 className="mt-8 font-serif text-[34px] leading-tight tracking-tight">{title}</h1>
      {description ? (
        <p className="mt-2 text-[15px] leading-relaxed text-foreground-muted">{description}</p>
      ) : null}

      <div className="mt-8">{children}</div>

      {footer ? <div className="mt-8 text-[13px] text-foreground-muted">{footer}</div> : null}
    </main>
  );
}
