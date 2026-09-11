import { beforeEach, describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv, parseEnv, resetEnvCache } from '../src/env.js';

/** The minimum a process needs to boot — mirrors the uncommented `.env.example`. */
const valid = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://konusbitr:konusbitr@localhost:5432/konusbitr',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'konusbitr',
  S3_ACCESS_KEY_ID: 'konusbitr',
  S3_SECRET_ACCESS_KEY: 'konusbitr-dev-secret',
  S3_FORCE_PATH_STYLE: 'true',
} satisfies Record<string, string>;

const REQUIRED = [
  'APP_URL',
  'DATABASE_URL',
  'REDIS_URL',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;

describe('parseEnv', () => {
  it('accepts the documented minimum and applies defaults', () => {
    const env = parseEnv(valid);

    expect(env.APP_URL).toBe('http://localhost:3000');
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.S3_REGION).toBe('us-east-1');
    expect(env.LLM_PROVIDER).toBe('openai');
    expect(env.OFFLINE_MODE).toBe(false);
    expect(env.BILLING_ENABLED).toBe(false);
    expect(env.CREDITS_MODE).toBe('unlimited');
    expect(env.OLLAMA_BASE_URL).toBe('http://localhost:11434');
  });

  it.each(REQUIRED)('fails with a message naming %s when it is missing', (name) => {
    const { [name]: _removed, ...rest } = valid;

    expect(() => parseEnv(rest)).toThrow(EnvValidationError);
    try {
      parseEnv(rest);
    } catch (error) {
      expect((error as EnvValidationError).message).toContain(
        `${name}: is required but was not set`,
      );
    }
  });

  it.each(REQUIRED)('treats an empty %s the same as a missing one', (name) => {
    expect(() => parseEnv({ ...valid, [name]: '   ' })).toThrow(
      new RegExp(`${name}: is required but was not set`),
    );
  });

  it('reports every offending variable at once', () => {
    try {
      parseEnv({ ...valid, DATABASE_URL: 'mysql://nope', REDIS_URL: 'http://nope' });
      expect.unreachable('expected a validation failure');
    } catch (error) {
      const { issues } = error as EnvValidationError;
      expect(issues).toContain('DATABASE_URL: must be a valid postgres:// URL');
      expect(issues).toContain('REDIS_URL: must be a valid redis:// URL');
    }
  });

  it('rejects an APP_URL with a trailing slash', () => {
    expect(() => parseEnv({ ...valid, APP_URL: 'http://localhost:3000/' })).toThrow(
      /APP_URL: must not have a trailing slash/,
    );
  });

  it('rejects a bucket name S3 would not accept', () => {
    expect(() => parseEnv({ ...valid, S3_BUCKET: 'Konusbitr Bucket' })).toThrow(
      /S3_BUCKET: must be a valid S3 bucket name/,
    );
  });

  it('rejects an unknown LLM provider by name', () => {
    expect(() => parseEnv({ ...valid, LLM_PROVIDER: 'cohere' })).toThrow(/LLM_PROVIDER/);
  });

  it('reads booleans written the way a .env writes them', () => {
    expect(parseEnv({ ...valid, OFFLINE_MODE: 'true' }).OFFLINE_MODE).toBe(true);
    expect(parseEnv({ ...valid, BILLING_ENABLED: '1' }).BILLING_ENABLED).toBe(true);
    expect(parseEnv({ ...valid, S3_FORCE_PATH_STYLE: 'false' }).S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('ignores variables it does not know about', () => {
    expect(() => parseEnv({ ...valid, SOMETHING_ELSE: 'x' })).not.toThrow();
  });
});

describe('loadEnv', () => {
  beforeEach(() => {
    resetEnvCache();
  });

  it('memoizes so later callers never re-validate', () => {
    expect(loadEnv(valid)).toBe(loadEnv({}));
  });
});
