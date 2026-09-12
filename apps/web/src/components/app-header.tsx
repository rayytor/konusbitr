import Link from 'next/link';
import { OrgSwitcher } from '@/components/settings/org-switcher';
import { SignOutButton } from '@/components/settings/sign-out-button';
import type { PageSession } from '@/lib/auth/session';

/**
 * The bar every signed-in page wears.
 *
 * The organization switcher lives here because the active organization is the
 * `orgId` of every request the page below will make — it belongs above the
 * thing it scopes, not inside one section of it.
 */
export function AppHeader({ session }: { session: PageSession }) {
  return (
    <header className="border-b border-border-subtle">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-[13px] text-foreground-subtle">
            Konusbitr
          </Link>
          <OrgSwitcher organizations={session.organizations} activeOrgId={session.orgId} />
        </div>
        <div className="flex items-center gap-3">
          <Link href="/library" className="text-[13px] text-foreground-muted">
            Library
          </Link>
          <Link href="/settings/api-keys" className="text-[13px] text-foreground-muted">
            Settings
          </Link>
          <span className="hidden text-[13px] text-foreground-muted sm:inline">
            {session.email}
          </span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
