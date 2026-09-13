/**
 * Where to send someone once they are signed in.
 *
 * `requireSession` sends an anonymous reader to `/login?redirect=<path>`, and
 * the invitation page does the same, so the sign-in surfaces have to read that
 * parameter back — otherwise every guarded link in the product lands on the API
 * keys page instead of the page that was asked for.
 *
 * The value arrives from the query string, which means it arrives from whoever
 * wrote the link. It is therefore treated as untrusted: only a path on this
 * origin is ever returned, so a crafted `?redirect=https://evil.example` cannot
 * turn the login page into an open redirector — `window.location.assign` and
 * Better Auth's `callbackURL` would both happily follow an absolute URL.
 */

/**
 * Where a sign-in that asked for nothing in particular ends up.
 *
 * The library, as of Phase 11. Before there was a product to land in, this was
 * the API keys page — which was the only surface worth arriving at. It is not
 * any more, and the first screen after signing in should be the one the product
 * is for.
 */
export const DEFAULT_REDIRECT = '/documents';

/**
 * Narrow a `?redirect=` query parameter to a same-origin path.
 *
 * Anything else — an absolute URL, a protocol-relative `//host`, the backslash
 * variant that some parsers read as a host, a control character, or a repeated
 * parameter — falls back to {@link DEFAULT_REDIRECT} rather than failing,
 * because a mangled link is not a reason to refuse to sign someone in.
 */
export function safeRedirect(
  value: string | string[] | undefined,
  fallback: string = DEFAULT_REDIRECT,
): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;

  // A path, not a URL: one leading slash, and nothing a parser could read as
  // the start of an authority component.
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;

  // Control characters, including the tab, newline and carriage return that a
  // browser strips before parsing a URL — which is how `/\t/evil.example` gets
  // past a check that only looks at the first two characters.
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;

  return value;
}

/** Carry the current `?redirect=` across to the other sign-in page. */
export function withRedirect(href: string, redirectTo: string): string {
  if (redirectTo === DEFAULT_REDIRECT) return href;
  return `${href}?redirect=${encodeURIComponent(redirectTo)}`;
}
