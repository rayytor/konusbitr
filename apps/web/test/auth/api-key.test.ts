import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  API_KEY_PREFIX,
  API_KEY_RANDOM_LENGTH,
  apiKeyPrefix,
  generateApiKey,
  hashApiKey,
  looksLikeApiKey,
  verifyApiKey,
} from '@/lib/auth/api-key';

describe('generateApiKey', () => {
  it('produces the documented shape', () => {
    const { token, prefix, hashedKey } = generateApiKey();

    expect(token.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(token).toHaveLength(API_KEY_PREFIX.length + API_KEY_RANDOM_LENGTH);
    expect(prefix).toBe(token.slice(0, API_KEY_PREFIX.length + 8));
    expect(hashedKey).toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateApiKey().token));
    expect(tokens.size).toBe(500);
  });

  it('uses only the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i += 1) {
      const random = generateApiKey().token.slice(API_KEY_PREFIX.length);
      // No 0/O and no 1/l/I, so a key can be read aloud and retyped.
      expect(random).not.toMatch(/[0O1lI]/);
    }
  });
});

describe('verifyApiKey', () => {
  it('accepts the key it was derived from', () => {
    const { token, hashedKey } = generateApiKey();
    expect(verifyApiKey(token, hashedKey)).toBe(true);
  });

  it('rejects any other key, including one sharing the prefix', () => {
    const mine = generateApiKey();
    const theirs = generateApiKey();

    expect(verifyApiKey(theirs.token, mine.hashedKey)).toBe(false);
    // A key that matches for its whole displayed prefix still fails.
    const impostor = `${mine.prefix}${theirs.token.slice(mine.prefix.length)}`;
    expect(apiKeyPrefix(impostor)).toBe(mine.prefix);
    expect(verifyApiKey(impostor, mine.hashedKey)).toBe(false);
  });

  it('rejects a malformed stored hash instead of throwing', () => {
    const { token } = generateApiKey();
    expect(verifyApiKey(token, 'not-hex')).toBe(false);
    expect(verifyApiKey(token, '')).toBe(false);
    expect(verifyApiKey(token, hashApiKey(token).slice(0, 10))).toBe(false);
  });
});

describe('looksLikeApiKey', () => {
  it('screens out anything that cannot be one of ours', () => {
    expect(looksLikeApiKey(generateApiKey().token)).toBe(true);
    expect(looksLikeApiKey('kb_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
    expect(looksLikeApiKey(`${API_KEY_PREFIX}short`)).toBe(false);
    expect(looksLikeApiKey('')).toBe(false);
  });
});
