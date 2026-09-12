import type { ReactNode } from 'react';
import { AppHeader } from '@/components/app-header';
import type { PageSession } from '@/lib/auth/session';

/**
 * The frame around the library.
 *
 * A single column, because the library is a list of documents and nothing else
 * yet. Phase 11 turns this into the three-column product surface; keeping the
 * shell separate from the list means that change touches one file.
 */
export function LibraryShell({
  session,
  title,
  description,
  children,
}: {
  session: PageSession;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh">
      <AppHeader session={session} />

      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="font-serif text-[30px] leading-tight tracking-tight">{title}</h1>
        <p className="mt-2 max-w-prose text-[15px] leading-relaxed text-foreground-muted">
          {description}
        </p>
        <div className="mt-10">{children}</div>
      </main>
    </div>
  );
}
