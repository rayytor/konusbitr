import { EnvValidationError } from '@konusbitr/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEVELOPMENT_AUTH_SECRET, parseWebEnv, resetWebEnvCache } from '@/lib/env';

/** A complete, valid environment. Individual tests bend one variable at a time. */
function base(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'development',
    APP_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://konusbitr:konusbitr@localhost:5432/konusbitr',
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'konusbitr',
    S3_ACCESS_KEY_ID: 'konusbitr',
    S3_SECRET_ACCESS_KEY: 'konusbitr-dev-secret',
    AUTH_SECRET: DEVELOPMENT_AUTH_SECRET,
    ...overrides,
  };
}

beforeEach(() => resetWebEnvCache());

describe('AUTH_SECRET', () => {
  it('is required', () => {
    expect(() => parseWebEnv(base({ AUTH_SECRET: undefined }))).toThrow(
      /AUTH_SECRET: is required but was not set/,
    );
  });

  it('must be long enough to be worth signing with', () => {
    expect(() => parseWebEnv(base({ AUTH_SECRET: 'short' }))).toThrow(/at least 32 characters/);
  });

  it('accepts the development value on a laptop', () => {
    expect(parseWebEnv(base()).AUTH_SECRET).toBe(DEVELOPMENT_AUTH_SECRET);
  });

  it('refuses the development value in production', () => {
    // `.env.example` ships a working secret so the stack comes up with one
    // command. That convenience must not survive a production deploy.
    expect(() => parseWebEnv(base({ NODE_ENV: 'production' }))).toThrow(
      /still the development value/,
    );
  });
});

describe('OAuth configuration', () => {
  it('is entirely optional', () => {
    const env = parseWebEnv(base());
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(env.GITHUB_CLIENT_ID).toBeUndefined();
  });

  it('accepts a complete pair', () => {
    const env = parseWebEnv(base({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }));
    expect(env.GITHUB_CLIENT_ID).toBe('id');
  });

  it('refuses half a pair at boot rather than at the first click', () => {
    expect(() => parseWebEnv(base({ GOOGLE_CLIENT_ID: 'id' }))).toThrow(
      /GOOGLE_CLIENT_ID: set both the client id and the client secret/,
    );
    expect(() => parseWebEnv(base({ GITHUB_CLIENT_SECRET: 'secret' }))).toThrow(
      /GITHUB_CLIENT_ID: set both/,
    );
  });
});

describe('failure reporting', () => {
  it('names every offending variable at once', () => {
    let caught: unknown;
    try {
      parseWebEnv(base({ AUTH_SECRET: undefined, DATABASE_URL: 'not-a-url' }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvValidationError);
    const issues = (caught as EnvValidationError).issues;
    expect(issues).toContain('AUTH_SECRET: is required but was not set');
    expect(issues.some((issue) => issue.startsWith('DATABASE_URL:'))).toBe(true);
  });

  it('treats a blank value as unset, not as an empty string', () => {
    expect(() => parseWebEnv(base({ AUTH_SECRET: '   ' }))).toThrow(
      /AUTH_SECRET: is required but was not set/,
    );
  });
});

describe('EMAIL_FROM', () => {
  it('has a default so signup works without configuring mail', () => {
    expect(parseWebEnv(base()).EMAIL_FROM).toContain('@');
  });
});
