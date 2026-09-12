import { API_KEY_PREFIX } from './api-key.js';

/**
 * Strip secrets out of anything on its way to a log.
 *
 * Konusbitr's rule is that a raw API key, a password and a session token never
 * appear in output — not in a request log, not in an error message, not in the
 * error reporting that Phase 12 adds. The rule is easy to state and easy to
 * break by accident, which is why it is a function with a test rather than a
 * convention.
 *
 * This redacts by *key name* as well as by value shape. A field called
 * `password` is redacted whatever it contains, because the alternative is
 * guessing what a password looks like.
 */

export const REDACTED = '[redacted]';

/** Field names whose value is always a secret, regardless of its shape. */
const SECRET_KEYS = [
  'password',
  'newpassword',
  'currentpassword',
  'token',
  'apikey',
  'api_key',
  'hashedkey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'secret',
  'authorization',
  'cookie',
  'setcookie',
  'sessiontoken',
];

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
  return SECRET_KEYS.some((candidate) => normalized === candidate.replace(/[-_]/g, ''));
}

/** Matches a Konusbitr API key wherever it appears inside free text. */
const API_KEY_PATTERN = new RegExp(`${API_KEY_PREFIX}[A-Za-z0-9]{8,}`, 'g');

/** Matches a `Bearer …` or `Basic …` credential inside free text. */
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic)\s+[\w\-._~+/=]+/gi;

/** Replace any secret that appears inside a string. */
export function redactString(value: string): string {
  return value.replace(API_KEY_PATTERN, REDACTED).replace(AUTH_HEADER_PATTERN, `$1 ${REDACTED}`);
}

/**
 * Deep-redact a value for logging.
 *
 * Cycles are replaced with `[circular]` rather than throwing: a logging helper
 * that can itself crash the request is worse than a slightly lossy log line.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : redact(item, seen);
  }
  return out;
}
