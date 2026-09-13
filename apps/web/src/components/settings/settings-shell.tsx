import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import type { PageSession } from '@/lib/auth/session';

/**
 * The settings frame.
 *
 * Settings is a *section of the application*, not a second application, so it
 * wears the same chrome as everything else: `AppShell`'s sidebar, with the
 * current section marked in it. It used to render its own top bar and its own
 * section nav instead, which meant opening API keys replaced the sidebar —
 * Library disappeared, the organization switcher and sign-out moved, and the
 * content column jumped from the left edge to a centred `max-w-5xl`. Three
 * chrome changes to move between two links that sit next to each other.
 *
 * The page header matches the library's geometry exactly (`design.md` §4 asks
 * for one shell), so navigating between them moves the content and nothing
 * else.
 */
export function SettingsShell({
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
    <AppShell session={session}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="px-6 pt-8 pb-5 sm:px-8">
          <h1 className="font-serif text-[30px] leading-tight tracking-tight">{title}</h1>
          <p className="mt-1 max-w-prose text-[15px] leading-relaxed text-foreground-muted">
            {description}
          </p>
        </div>

        {/* Settings is prose and forms, so it is capped for line length —
            but left-aligned, not centred, so the column does not shift
            when you arrive from the library. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-12 sm:px-8">
          <div className="max-w-2xl">{children}</div>
        </div>
      </div>
    </AppShell>
  );
}
