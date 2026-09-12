import { describe, expect, it } from 'vitest';
import { DEFAULT_REDIRECT, safeRedirect, withRedirect } from '@/lib/auth/redirect';

/**
 * `?redirect=` is the one piece of the sign-in flow an attacker gets to write,
 * so the tests below are half "the parameter is honoured" and half "the
 * parameter cannot send anyone off-site".
 */
describe('safeRedirect', () => {
  it('honours a same-origin path', () => {
    expect(safeRedirect('/settings/members')).toBe('/settings/members');
    expect(safeRedirect('/accept-invitation/inv_123')).toBe('/accept-invitation/inv_123');
    expect(safeRedirect('/documents?page=2#cite-4')).toBe('/documents?page=2#cite-4');
  });

  it('falls back when the parameter is absent or empty', () => {
    expect(safeRedirect(undefined)).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect('')).toBe(DEFAULT_REDIRECT);
  });

  it('falls back when the parameter is repeated', () => {
    // `?redirect=/a&redirect=//evil.example` arrives as an array.
    expect(safeRedirect(['/settings/members', '//evil.example'])).toBe(DEFAULT_REDIRECT);
  });

  it('refuses anything that is not a path on this origin', () => {
    for (const hostile of [
      'https://evil.example',
      'http://evil.example',
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'settings/members',
    ]) {
      expect(safeRedirect(hostile)).toBe(DEFAULT_REDIRECT);
    }
  });

  it('refuses control characters a browser would strip before parsing', () => {
    expect(safeRedirect('/\t/evil.example')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect('/\n/evil.example')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect('/\r/evil.example')).toBe(DEFAULT_REDIRECT);
  });

  it('takes a caller-supplied fallback', () => {
    expect(safeRedirect('https://evil.example', '/')).toBe('/');
  });
});

describe('withRedirect', () => {
  it('carries a non-default destination across to the other page', () => {
    expect(withRedirect('/signup', '/accept-invitation/inv_123')).toBe(
      '/signup?redirect=%2Faccept-invitation%2Finv_123',
    );
  });

  it('leaves the link clean when there is nothing to carry', () => {
    expect(withRedirect('/signup', DEFAULT_REDIRECT)).toBe('/signup');
  });

  it('round-trips through safeRedirect', () => {
    const target = '/documents?page=2';
    const href = withRedirect('/login', target);
    const value = new URL(href, 'http://localhost:3000').searchParams.get('redirect');
    expect(safeRedirect(value ?? undefined)).toBe(target);
  });
});
