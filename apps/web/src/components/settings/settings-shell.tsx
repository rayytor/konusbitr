import { KeyRound, Users } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AppHeader } from '@/components/app-header';
import type { PageSession } from '@/lib/auth/session';
import { cn } from '@/lib/utils';

/**
 * The settings frame: a narrow, quiet, icon-led nav beside the section, as
 * `design.md` §4 and §25 describe.
 */
const SECTIONS = [
  { href: '/settings/api-keys', label: 'API keys', icon: KeyRound },
  { href: '/settings/members', label: 'Members', icon: Users },
] as const;

export function SettingsShell({
  session,
  active,
  title,
  description,
  children,
}: {
  session: PageSession;
  active: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh">
      <AppHeader session={session} />

      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10 sm:flex-row sm:gap-12">
        {/* On a phone this becomes a row of two links rather than a squeezed
            sidebar — simplify, do not cram. */}
        <nav aria-label="Settings" className="sm:w-44 sm:shrink-0">
          <ul className="flex gap-4 sm:flex-col sm:gap-1">
            {SECTIONS.map(({ href, label, icon: Icon }) => {
              const current = href === active;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={current ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm',
                      current
                        ? 'bg-surface-muted text-foreground'
                        : 'text-foreground-muted hover:text-foreground',
                    )}
                  >
                    <Icon aria-hidden className="size-4" />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <main className="min-w-0 flex-1">
          <h1 className="font-serif text-[30px] leading-tight tracking-tight">{title}</h1>
          <p className="mt-2 max-w-prose text-[15px] leading-relaxed text-foreground-muted">
            {description}
          </p>
          <div className="mt-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
