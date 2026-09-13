'use client';

import {
  KeyRound,
  Library,
  LogOut,
  Menu as MenuIcon,
  PanelLeft,
  PanelLeftClose,
  User,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { BrandIcon } from '@/components/brand-icon';
import { OrgSwitcher } from '@/components/settings/org-switcher';
import { SignOutButton } from '@/components/settings/sign-out-button';
import { ThemeToggle } from '@/components/theme-toggle';
import { Menu } from '@/components/ui/menu';
import { Tooltip } from '@/components/ui/tooltip';
import { authClient } from '@/lib/auth/client';
import type { PageSession } from '@/lib/auth/session';
import { usePersistedNumber, usePersistedState } from '@/lib/use-persisted-state';
import { cn } from '@/lib/utils';

const SIDEBAR_KEY = 'konusbitr.sidebar';
const SIDEBAR_WIDTH_KEY = 'konusbitr.sidebar.width';

/** The expanded sidebar's width, in pixels, and the range a drag may set. */
const DEFAULT_WIDTH = 224;
const MIN_WIDTH = 168;
const MAX_WIDTH = 380;

/** Arrow keys move the sidebar edge by this much per press. */
const KEYBOARD_STEP = 16;

/** Sign out, then land on the sign-in page. Shared by the sidebar and the phone menu. */
function signOut() {
  void authClient.signOut().then(() => window.location.assign('/login'));
}

/**
 * Primary navigation, in groups.
 *
 * Library is a destination; API keys and Members are two sections of settings.
 * Listing all three as flat siblings said they were the same kind of thing,
 * which is why the sidebar read as a pile of unrelated links. The group keeps
 * both settings sections one click away without claiming they rank alongside
 * the library.
 */
const NAV = [
  { label: null, items: [{ href: '/documents', label: 'Library', icon: Library }] },
  {
    label: 'Settings',
    items: [
      { href: '/settings/api-keys', label: 'API keys', icon: KeyRound },
      { href: '/settings/members', label: 'Members', icon: Users },
    ],
  },
] as const;

/**
 * The application shell: a narrow, quiet, icon-led sidebar and a content column.
 *
 * `design.md` §4 asks for navigation that is narrow, easy to collapse, icon-led
 * and free of decoration — so the collapsed state is the icons alone with
 * tooltips, the expanded state adds the labels, and the choice is remembered.
 * The width transition is one of the few `design.md` §19 sanctions.
 *
 * The workspace deliberately does not use this. A document and its chat want
 * every pixel, and the way back to the library is the arrow in its own header.
 */
export function AppShell({ session, children }: { session: PageSession; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = usePersistedState<boolean>(
    SIDEBAR_KEY,
    false,
    (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    (value) => String(value),
  );
  const [width, setWidth] = usePersistedNumber(SIDEBAR_WIDTH_KEY, DEFAULT_WIDTH, {
    min: MIN_WIDTH,
    max: MAX_WIDTH,
  });
  const navRef = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);

  const clampWidth = useCallback(
    (value: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value))),
    [],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const box = navRef.current?.getBoundingClientRect();
      if (!box) return;
      setWidth(clampWidth(event.clientX - box.left));
    },
    [clampWidth, setWidth],
  );

  useEffect(() => {
    if (!dragging) return;

    function onUp() {
      setDragging(false);
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onUp);
    // A drag across the content must not select the text it passes over, and
    // the cursor must not flicker as it leaves the handle's 11px hit area.
    const previousSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = previousSelect;
      document.body.style.cursor = '';
    };
  }, [dragging, onPointerMove]);

  return (
    <div className="flex min-h-dvh">
      <nav
        ref={navRef}
        aria-label="Main"
        style={collapsed ? undefined : { width }}
        className={cn(
          'relative hidden shrink-0 flex-col border-r border-border-subtle px-2 py-3 sm:flex',
          // The collapse toggle animates its width; a drag must not, or the
          // edge lags the pointer.
          collapsed ? 'w-14' : '',
          dragging ? '' : 'transition-[width] duration-[var(--motion-normal)]',
        )}
      >
        {collapsed ? null : (
          // biome-ignore lint/a11y/useSemanticElements: there is no HTML element for a resize handle; `separator` with aria-valuenow is what WAI-ARIA prescribes, and the tabIndex below makes it focusable.
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuenow={width}
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={MAX_WIDTH}
            tabIndex={0}
            onPointerDown={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                setWidth(clampWidth(width - KEYBOARD_STEP));
              }
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                setWidth(clampWidth(width + KEYBOARD_STEP));
              }
              if (event.key === 'Home') {
                event.preventDefault();
                setWidth(DEFAULT_WIDTH);
              }
            }}
            className="absolute inset-y-0 right-0 z-10 flex w-[11px] translate-x-1/2 cursor-col-resize touch-none items-stretch justify-center"
          >
            <span aria-hidden className={cn('w-px', dragging ? 'bg-accent' : 'bg-transparent')} />
          </div>
        )}
        <div
          className={cn(
            'flex items-center gap-2 px-1',
            collapsed ? 'flex-col gap-3 justify-center' : '',
          )}
        >
          {collapsed ? (
            <Link
              href="/documents"
              aria-label="Konusbitr Library"
              className="flex items-center justify-center p-0.5 text-foreground hover:opacity-80"
            >
              <BrandIcon className="size-5" />
            </Link>
          ) : (
            <Link
              href="/documents"
              className="flex items-center gap-2 font-serif text-[18px] leading-none"
            >
              <BrandIcon className="size-4.5" />
              <span>Konusbitr</span>
            </Link>
          )}
          <Tooltip label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} side="right">
            <button
              type="button"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed(!collapsed)}
              className="ml-auto flex size-8 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-foreground-subtle hover:text-foreground"
            >
              {collapsed ? (
                <PanelLeft aria-hidden className="size-4" />
              ) : (
                <PanelLeftClose aria-hidden className="size-4" />
              )}
            </button>
          </Tooltip>
        </div>

        <div className="mt-6 flex flex-col gap-4">
          {NAV.map((group, groupIndex) => (
            <div key={group.label ?? 'primary'}>
              {/* Expanded, the group is named. Collapsed there is no room for a
                  label, so a hairline carries the same grouping. */}
              {group.label ? (
                collapsed ? (
                  <div
                    aria-hidden
                    className={cn(
                      'mx-2 mb-2 h-px bg-border-subtle',
                      groupIndex === 0 ? 'hidden' : '',
                    )}
                  />
                ) : (
                  <p className="px-2.5 pb-1 text-[12px] tracking-[0.06em] text-foreground-subtle uppercase">
                    {group.label}
                  </p>
                )
              ) : null}
              <ul className="flex flex-col gap-0.5">
                {group.items.map((link) => {
                  const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
                  const Icon = link.icon;
                  const content = (
                    <Link
                      href={link.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-[15px]',
                        collapsed ? 'justify-center' : '',
                        active
                          ? 'bg-surface-muted text-foreground'
                          : 'text-foreground-muted hover:text-foreground',
                      )}
                    >
                      <Icon aria-hidden className="size-4 shrink-0" />
                      {collapsed ? <span className="sr-only">{link.label}</span> : link.label}
                    </Link>
                  );

                  return (
                    <li key={link.href}>
                      {collapsed ? (
                        <Tooltip label={link.label} side="right">
                          {content}
                        </Tooltip>
                      ) : (
                        content
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-auto flex flex-col gap-2 px-1 pt-4">
          {/*
            One line about who you are, not three. The workspace name only
            appears when there is more than one to switch between — with a
            single workspace it repeats the identity below it and switches
            nothing. The name is what identifies the reader day to day; the
            address is what they occasionally need to check which account they
            are in, so hovering swaps it in at the same size. What does not fit
            fades out at the edge instead of ending in an ellipsis.
          */}
          {collapsed ? null : (
            <>
              {session.organizations.length > 1 ? (
                <OrgSwitcher
                  organizations={session.organizations}
                  activeOrgId={session.orgId}
                  isGuest={session.isGuest}
                />
              ) : null}
              <p
                className="group/identity flex items-center gap-1.5 text-[13px] text-foreground-subtle"
                title={session.name ? `${session.name} — ${session.email}` : session.email}
              >
                {session.isGuest ? (
                  <User
                    aria-label="Guest user"
                    className="size-3 shrink-0 text-foreground-subtle"
                  />
                ) : null}
                {session.name ? (
                  <>
                    <span className="kb-fade-edge min-w-0 flex-1 group-hover/identity:hidden">
                      {session.name}
                    </span>
                    <span className="kb-fade-edge hidden min-w-0 flex-1 group-hover/identity:block">
                      {session.email}
                    </span>
                  </>
                ) : (
                  <span className="kb-fade-edge min-w-0 flex-1">{session.email}</span>
                )}
              </p>
            </>
          )}
          <div className={cn('flex items-center gap-1', collapsed ? 'flex-col' : '')}>
            {collapsed ? null : <ThemeToggle />}
            <SignOutButton iconOnly className={collapsed ? '' : 'ml-auto'} />
          </div>
        </div>
      </nav>

      {/* A compact bar instead of the sidebar below 640px, per §21. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-2.5 sm:hidden">
          <Link href="/documents" className="flex items-center gap-2 font-serif text-[18px]">
            <BrandIcon className="size-4.5" />
            <span>Konusbitr</span>
          </Link>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            {/*
              Below 640px the sidebar is gone, so this menu is the only way to
              every other destination — and to signing out. It used to be a
              gear that went to API keys and nothing else, which left Members
              and sign-out unreachable on a phone.
            */}
            <Menu
              label="Menu"
              items={[
                ...NAV.flatMap((group) =>
                  group.items.map((link) => ({
                    label: link.label,
                    icon: link.icon,
                    onSelect: () => router.push(link.href),
                  })),
                ),
                {
                  label: 'Sign out',
                  icon: LogOut,
                  destructive: true,
                  onSelect: signOut,
                },
              ]}
              trigger={(props) => (
                <button
                  {...props}
                  type="button"
                  aria-label="Menu"
                  className="flex size-9 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-foreground-muted hover:text-foreground"
                >
                  <MenuIcon aria-hidden className="size-4" />
                </button>
              )}
            />
          </div>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
