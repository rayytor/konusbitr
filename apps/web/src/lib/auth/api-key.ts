import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Konusbitr API keys.
 *
 * A key is shown to its creator exactly once. What the database keeps is a
 * SHA-256 hash plus a short, non-secret `prefix` — enough to display the key in
 * a list and to narrow the lookup to a handful of rows, and not enough to
 * authenticate with.
 *
 * SHA-256 rather than a password KDF is deliberate: a 32-character key drawn
 * from a 160-bit random source has no guessable structure, so there is nothing
 * for a slow hash to defend against, and a per-request scrypt would be a real
 * cost on the API's hot path.
 */

/** Everything before the random part. `live` leaves room for a `test` mode. */
export const API_KEY_PREFIX = 'kb_live_';

/** Characters of randomness after the prefix, per the Phase 04 specification. */
export const API_KEY_RANDOM_LENGTH = 32;

/** How much of a key is stored in the clear, prefix included. */
export const API_KEY_DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;

/**
 * Unambiguous alphabet: no `0`/`O`, no `1`/`l`/`I`. Keys get read aloud and
 * retyped, and a base64 key with a `+` in it is a support ticket waiting to
 * happen.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export type GeneratedApiKey = {
  /** The full secret. Returned to the creator once and never stored. */
  token: string;
  /** SHA-256 of the token, hex encoded. This is what goes in the database. */
  hashedKey: string;
  /** The non-secret leading characters, for display and for lookup. */
  prefix: string;
};

/**
 * Draw a new key.
 *
 * Rejection sampling keeps the alphabet uniform: taking `byte % 56` would make
 * the first eight characters of the alphabet very slightly likelier, and there
 * is no reason to accept even a slight bias in a credential.
 */
export function generateApiKey(): GeneratedApiKey {
  const limit = 256 - (256 % ALPHABET.length);
  let random = '';

  while (random.length < API_KEY_RANDOM_LENGTH) {
    for (const byte of randomBytes(API_KEY_RANDOM_LENGTH)) {
      if (byte >= limit) continue;
      random += ALPHABET[byte % ALPHABET.length];
      if (random.length === API_KEY_RANDOM_LENGTH) break;
    }
  }

  const token = `${API_KEY_PREFIX}${random}`;
  return { token, hashedKey: hashApiKey(token), prefix: apiKeyPrefix(token) };
}

/** SHA-256 of a key, hex encoded. */
export function hashApiKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The stored, non-secret prefix of a key. */
export function apiKeyPrefix(token: string): string {
  return token.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH);
}

/** Whether a presented string is even shaped like one of our keys. */
export function looksLikeApiKey(token: string): boolean {
  return (
    token.startsWith(API_KEY_PREFIX) &&
    token.length === API_KEY_PREFIX.length + API_KEY_RANDOM_LENGTH
  );
}

/**
 * Compare a presented key against a stored hash without leaking, through
 * timing, how many leading characters matched.
 *
 * Both sides are hex digests of a fixed length, so a length mismatch means the
 * stored value is corrupt rather than that the key is wrong — bail before
 * `timingSafeEqual` throws on mismatched buffers.
 */
export function verifyApiKey(token: string, hashedKey: string): boolean {
  const presented = Buffer.from(hashApiKey(token), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(hashedKey, 'hex');
  } catch {
    return false;
  }
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}
