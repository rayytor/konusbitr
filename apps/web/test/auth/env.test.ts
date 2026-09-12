import { EnvValidationError } from '@konusbitr/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_AUTH_SECRET,
  isLoopbackOrigin,
  isSecureOrigin,
  parseWebEnv,
  resetWebEnvCache,
} from '@/lib/env';

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

  it('accepts it in the Compose stack, which is still only localhost', () => {
    // The web container runs with NODE_ENV=production because that is how
    // Next.js is served. That says nothing about who can reach it.
    expect(parseWebEnv(base({ NODE_ENV: 'production' })).AUTH_SECRET).toBe(DEVELOPMENT_AUTH_SECRET);
  });

  it('refuses the development value once APP_URL is a real host', () => {
    // `.env.example` ships a working secret so the stack comes up with one
    // command. That convenience must not survive being pointed at a domain.
    expect(() => parseWebEnv(base({ APP_URL: 'https://konusbitr.example.com' }))).toThrow(
      /still the development value/,
    );
  });

  it('accepts a real secret on a real host', () => {
    const env = parseWebEnv(
      base({ APP_URL: 'https://konusbitr.example.com', AUTH_SECRET: 'x'.repeat(44) }),
    );
    expect(env.APP_URL).toBe('https://konusbitr.example.com');
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

describe('isSecureOrigin', () => {
  it('follows the URL scheme rather than NODE_ENV', () => {
    // A `__Secure-` cookie that did not arrive over HTTPS is silently dropped
    // by the browser, so the Compose container — a production build serving
    // plain HTTP on localhost — must not set one.
    expect(isSecureOrigin('http://localhost:3000')).toBe(false);
    expect(isSecureOrigin('https://konusbitr.example.com')).toBe(true);
    expect(isSecureOrigin('not a url')).toBe(false);
  });
});

describe('isLoopbackOrigin', () => {
  it('recognises the addresses that mean "only this machine"', () => {
    expect(isLoopbackOrigin('http://localhost:3000')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:3000')).toBe(true);
    expect(isLoopbackOrigin('https://konusbitr.example.com')).toBe(false);
    expect(isLoopbackOrigin('')).toBe(false);
  });
});
