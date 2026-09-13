import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_REDIRECT } from '@/lib/auth/redirect';

/**
 * The pages, not just the helper: `?redirect=` has to reach every door on them.
 *
 * These call the server components directly and read the element tree they
 * return, which is enough to prove the parameter is plumbed through without
 * standing up a DOM. `config` is mocked because the only thing these pages want
 * from it is the list of OAuth providers, and building a real Better Auth
 * instance would drag in Postgres and Redis.
 */
vi.mock('@/lib/auth/config', () => ({
  enabledSocialProviders: () => ['google', 'github'],
  auth: () => {
    throw new Error('not used by these pages');
  },
}));

const { default: LoginPage } = await import('@/app/login/page');
const { default: SignupPage } = await import('@/app/signup/page');

/** Every `prop` found anywhere in a rendered element tree. */
function propValues(node: unknown, prop: string, found: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const child of node) propValues(child, prop, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;

  const props = (node as ReactElement).props as Record<string, unknown> | undefined;
  if (props) {
    if (prop in props) found.push(props[prop]);
    for (const value of Object.values(props)) propValues(value, prop, found);
  }
  return found;
}

describe('/login', () => {
  it('sends every door to the requested page', async () => {
    const tree = await LoginPage({
      searchParams: Promise.resolve({ redirect: '/settings/members' }),
    });

    // The password/magic-link form, the OAuth buttons, and the link to signup.
    expect(propValues(tree, 'redirectTo')).toEqual(['/settings/members']);
    expect(propValues(tree, 'callbackURL')).toEqual(['/settings/members']);
    expect(propValues(tree, 'href')).toContain('/signup?redirect=%2Fsettings%2Fmembers');
  });

  it('falls back to the default destination', async () => {
    const tree = await LoginPage({ searchParams: Promise.resolve({}) });

    expect(propValues(tree, 'redirectTo')).toEqual([DEFAULT_REDIRECT]);
    expect(propValues(tree, 'callbackURL')).toEqual([DEFAULT_REDIRECT]);
    expect(propValues(tree, 'href')).toContain('/signup');
  });

  it('refuses an off-site destination', async () => {
    const tree = await LoginPage({
      searchParams: Promise.resolve({ redirect: 'https://evil.example' }),
    });

    expect(propValues(tree, 'redirectTo')).toEqual([DEFAULT_REDIRECT]);
    expect(propValues(tree, 'callbackURL')).toEqual([DEFAULT_REDIRECT]);
  });
});

describe('/signup', () => {
  it('sends every door to the requested page', async () => {
    const tree = await SignupPage({
      searchParams: Promise.resolve({ redirect: '/accept-invitation/inv_123' }),
    });

    expect(propValues(tree, 'redirectTo')).toEqual([
      '/accept-invitation/inv_123',
      '/accept-invitation/inv_123',
    ]);
    expect(propValues(tree, 'callbackURL')).toEqual(['/accept-invitation/inv_123']);
    expect(propValues(tree, 'href')).toContain('/login?redirect=%2Faccept-invitation%2Finv_123');
  });

  it('refuses an off-site destination', async () => {
    const tree = await SignupPage({
      searchParams: Promise.resolve({ redirect: '//evil.example' }),
    });

    expect(propValues(tree, 'redirectTo')).toEqual([DEFAULT_REDIRECT, DEFAULT_REDIRECT]);
    expect(propValues(tree, 'callbackURL')).toEqual([DEFAULT_REDIRECT]);
  });
});
