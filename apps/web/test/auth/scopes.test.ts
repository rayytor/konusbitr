import { describe, expect, it } from 'vitest';
import {
  ALL_SCOPES,
  API_SCOPES,
  isApiScope,
  missingScope,
  sanitizeScopes,
} from '@/lib/auth/scopes';

describe('the scope vocabulary', () => {
  it('is exactly what Phase 04 specifies', () => {
    // These names are the public contract of the /v2 API. Changing one is a
    // migration of every stored `api_keys.scopes` array, not a rename.
    expect([...API_SCOPES]).toEqual([
      'parse',
      'extract',
      'split',
      'ask',
      'chat',
      'documents:read',
      'documents:write',
    ]);
  });
});

describe('sanitizeScopes', () => {
  it('drops anything unrecognised', () => {
    expect(sanitizeScopes(['chat', 'documents:read', 'admin', ''])).toEqual([
      'chat',
      'documents:read',
    ]);
  });

  it('collapses duplicates and normalises order', () => {
    expect(sanitizeScopes(['documents:read', 'chat', 'chat'])).toEqual(['chat', 'documents:read']);
  });
});

describe('missingScope', () => {
  it('names the first scope the principal lacks', () => {
    expect(missingScope(['chat'], ['chat', 'documents:read'])).toBe('documents:read');
  });

  it('returns null when every requirement is held', () => {
    expect(missingScope(['chat', 'parse'], ['chat'])).toBeNull();
    expect(missingScope([], [])).toBeNull();
    expect(missingScope(ALL_SCOPES, API_SCOPES)).toBeNull();
  });
});

describe('isApiScope', () => {
  it('narrows an untrusted string', () => {
    expect(isApiScope('parse')).toBe(true);
    expect(isApiScope('parse ')).toBe(false);
    expect(isApiScope('superuser')).toBe(false);
  });
});
