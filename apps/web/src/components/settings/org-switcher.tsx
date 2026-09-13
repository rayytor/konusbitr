'use client';

import { Check, ChevronsUpDown, User } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { authClient } from '@/lib/auth/client';
import { cn } from '@/lib/utils';

type Organization = { id: string; name: string; slug: string; role: string };

/**
 * Switch the active organization.
 *
 * The choice is written to the *session*, not to component state: the active
 * organization is the `orgId` of every request that follows, so it has to
 * survive a reload and be visible to the server. The refresh after the write is
 * what re-renders the page under the new scope.
 *
 * The menu opens with a transition, which motion is for. Nothing here animates
 * on hover.
 */
export function OrgSwitcher({
  organizations,
  activeOrgId,
  isGuest,
}: {
  organizations: Organization[];
  activeOrgId: string;
  isGuest?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  const active = organizations.find((org) => org.id === activeOrgId);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function choose(orgId: string) {
    if (orgId === activeOrgId) {
      setOpen(false);
      return;
    }
    setPending(true);
    await authClient.organization.setActive({ organizationId: orgId });
    setPending(false);
    setOpen(false);
    router.refresh();
  }

  // One organization is the common case and a switcher with nothing to switch
  // to is clutter, so it renders as plain text.
  if (organizations.length <= 1) {
    return (
      <span className="flex items-center gap-1.5 text-[15px] text-foreground">
        {isGuest ? (
          <User aria-label="Guest user" className="size-3.5 shrink-0 text-foreground-muted" />
        ) : null}
        <span className="truncate">{active?.name ?? 'Workspace'}</span>
      </span>
    );
  }

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={pending}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 text-[15px]',
          'hover:bg-surface-muted',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        )}
      >
        {isGuest ? (
          <User aria-label="Guest user" className="size-3.5 shrink-0 text-foreground-muted" />
        ) : null}
        <span className="truncate">{active?.name ?? 'Workspace'}</span>
        <ChevronsUpDown aria-hidden className="size-3.5 text-foreground-subtle" />
      </button>

      {open ? (
        <ul
          aria-label="Switch workspace"
          className={cn(
            'absolute left-0 top-full z-10 mt-1 min-w-56 overflow-hidden',
            'rounded-[var(--radius-md)] border border-border bg-surface py-1',
            'kb-menu-enter',
          )}
        >
          {organizations.map((org) => {
            const current = org.id === activeOrgId;
            return (
              <li key={org.id}>
                <button
                  type="button"
                  aria-current={current ? 'true' : undefined}
                  onClick={() => void choose(org.id)}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-2 text-left text-[15px] hover:bg-surface-muted focus-visible:outline-none focus-visible:bg-surface-muted"
                >
                  <span className="truncate">{org.name}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-[13px] text-foreground-subtle">{org.role}</span>
                    {current ? <Check aria-hidden className="size-3.5" /> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
