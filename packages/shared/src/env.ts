import { z } from 'zod';
import { DEFAULT_MAX_UPLOAD_BYTES } from './upload.js';

/**
 * Runtime configuration, validated once at process start.
 *
 * Konusbitr fails loudly at boot on a missing or malformed variable rather than
 * lazily at first use: a self-hoster should learn that `S3_BUCKET` is empty when
 * the container starts, not when the first upload is attempted an hour later.
 *
 * This schema is the TypeScript half of the contract. The Python worker
 * validates the same variables with pydantic-settings in
 * `konusbitr_worker.settings`; the two must be kept in step, and `.env.example`
 * is the documentation for both.
 */

export const NODE_ENVS = ['development', 'test', 'production'] as const;

/** Providers the LiteLLM router knows how to address. */
export const LLM_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'mistral',
  'ollama',
  'vllm',
] as const;

/** `unlimited` is the self-host default; `metered` is what the hosted API bills on. */
export const CREDITS_MODES = ['unlimited', 'metered'] as const;

/**
 * A URL restricted to a set of protocols.
 *
 * Written as a refinement over `URL` rather than with `z.url({ protocol })` so
 * the message names the variable's expected shape in the same voice for every
 * scheme, including `postgres:` and `redis:` which are not web URLs.
 */
function urlWithProtocol(protocols: readonly string[], label: string) {
  return z
    .string()
    .trim()
    .refine(
      (value) => {
        try {
          return protocols.includes(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      { message: `must be a valid ${label} URL` },
    );
}

const httpUrl = urlWithProtocol(['http:', 'https:'], 'http(s)');
const postgresUrl = urlWithProtocol(['postgres:', 'postgresql:'], 'postgres://');
const redisUrl = urlWithProtocol(['redis:', 'rediss:'], 'redis://');

const nonEmpty = z.string().trim().min(1);

/**
 * A byte count, given as a plain number of bytes.
 *
 * Deliberately not `500MB`-style shorthand: a unit suffix is one more thing to
 * get subtly wrong (is `MB` 10^6 or 2^20?) in a variable whose only job is to
 * be an unambiguous ceiling.
 */
const byteCount = z.coerce.number().int().positive();

/** Origin the app is served from. No trailing slash, so joins stay predictable. */
const originUrl = httpUrl.refine((value) => !value.endsWith('/'), {
  message: 'must not have a trailing slash',
});

/**
 * S3 bucket names are DNS labels; rejecting the rest here keeps the failure at
 * boot instead of inside a signing error on the first presigned PUT.
 */
const bucketName = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, {
    message: 'must be a valid S3 bucket name (lowercase letters, digits, dots and dashes)',
  });

export const EnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  APP_URL: originUrl,

  // Phase 02 — local infrastructure.
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,

  // Storage. Any S3-compatible endpoint: MinIO locally, S3/R2/B2 in production.
  S3_ENDPOINT: httpUrl,
  S3_REGION: nonEmpty.default('us-east-1'),
  S3_BUCKET: bucketName,
  S3_ACCESS_KEY_ID: nonEmpty,
  S3_SECRET_ACCESS_KEY: nonEmpty,
  /** MinIO and most non-AWS endpoints need path-style addressing. */
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),

  // Ingest limits. Both are ceilings an operator raises or lowers; neither is a
  // product decision, which is why they are configuration rather than constants.
  /** Largest file the intake path will accept, in bytes. Default 500MB. */
  MAX_UPLOAD_BYTES: byteCount.default(DEFAULT_MAX_UPLOAD_BYTES),
  /** Page ceiling per document. `0` means unlimited, which is the self-host default. */
  MAX_PAGES: z.coerce.number().int().min(0).default(0),

  /**
   * Whether a parse may be reused across organizations.
   *
   * **Off by default, and it must stay that way for any multi-tenant
   * deployment.** A global cache is a disclosure channel: an organization that
   * uploads a file and gets an instant `ready` back has learned that some other
   * organization on this instance already holds that exact file. On a
   * single-tenant self-hosted instance there is no one to learn anything, and
   * the saving is real, so the opt-in exists — as an operator decision, spelled
   * out here and in `.env.example`.
   */
  ALLOW_GLOBAL_PARSE_CACHE: z.stringbool().default(false),

  // Models. Every call goes through the LiteLLM router, never a provider SDK.
  LLM_PROVIDER: z.enum(LLM_PROVIDERS).default('openai'),
  LLM_API_KEY: nonEmpty.optional(),
  LLM_CHAT_MODEL: nonEmpty.optional(),
  EMBEDDING_MODEL: nonEmpty.optional(),
  OLLAMA_BASE_URL: httpUrl.default('http://localhost:11434'),
  /** When true, any non-local model endpoint must raise immediately. */
  OFFLINE_MODE: z.stringbool().default(false),

  // Billing.
  BILLING_ENABLED: z.stringbool().default(false),
  CREDITS_MODE: z.enum(CREDITS_MODES).default('unlimited'),
});

export type Env = z.infer<typeof EnvSchema>;

/** Raised instead of a bare `ZodError` so callers can print and exit cleanly. */
export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';

  constructor(
    message: string,
    readonly issues: readonly string[],
  ) {
    super(message);
  }
}

/** Variables that are present but empty are treated as absent, not as `''`. */
function withoutBlanks(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') out[key] = value;
  }
  return out;
}

/**
 * Validate a bag of variables, raising {@link EnvValidationError} with a message
 * that names every offending variable — the whole point is that an operator can
 * fix the `.env` from the container log alone.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const candidate = withoutBlanks(source);
  const result = EnvSchema.safeParse(candidate);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const name = String(issue.path[0] ?? '(root)');
    const detail = name in candidate ? issue.message : 'is required but was not set';
    return `${name}: ${detail}`;
  });

  const message = [
    'Invalid environment configuration:',
    ...issues.map((issue) => `  - ${issue}`),
    '',
    'Copy .env.example to .env and fill in the values it documents.',
  ].join('\n');

  throw new EnvValidationError(message, issues);
}

let cached: Env | undefined;

/**
 * The process-wide environment. Memoized: call it once from a boot hook so the
 * process dies before serving traffic, then freely afterwards.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  cached ??= parseEnv(source);
  return cached;
}

/** Test-only: drop the memoized value so a fresh source can be parsed. */
export function resetEnvCache(): void {
  cached = undefined;
}
