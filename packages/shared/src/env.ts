import { z } from 'zod';
import { CHUNKING_DEFAULTS } from './chunk.js';
import {
  CLOUD_LLM_PROVIDERS,
  EMBEDDING_DIMENSIONS,
  isLocalProvider,
  LLM_PROVIDERS,
  type LlmProvider,
  LOCAL_LLM_PROVIDERS,
  MODEL_ROLES,
  type ModelRole,
  providerCanEmbed,
} from './models.js';
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

  // Phase 07 — parse.
  /**
   * The extractable-character coverage a page must reach for the standard
   * parser to treat it as born-digital, as a fraction in [0, 1].
   *
   * Read by the worker, not by the web app — but it lives here because it is
   * one `.env`, and a variable that only one half validates is a variable that
   * can be misspelled in the file the other half reads.
   */
  TEXT_COVERAGE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.1),

  // ── Phase 08 — the model router ──────────────────────────────────────────
  //
  // Every model call goes through one router: LiteLLM in the Python worker,
  // the OpenAI-compatible client in `@konusbitr/ai`. Never a provider SDK.
  //
  // Roles are configured independently, because operators genuinely mix them:
  // a cloud chat model with local embeddings is the shape a law firm wants,
  // and all-local is the shape a government deployment requires. Each role
  // falls back to `LLM_PROVIDER` when it names no provider of its own, so the
  // common case stays one variable.

  /** The provider every role falls back to. */
  LLM_PROVIDER: z.enum(LLM_PROVIDERS).default('openai'),
  /**
   * The single cloud credential.
   *
   * One key rather than one per role: mixing two *different* cloud providers
   * across roles is rare enough that it is a documented follow-up rather than
   * four more variables, and local providers need no key at all.
   */
  LLM_API_KEY: nonEmpty.optional(),
  /**
   * An OpenAI-compatible base URL to route through instead of the provider's
   * own. This is how a self-hoster puts a LiteLLM proxy, a gateway or an
   * air-gapped mirror in front of everything.
   */
  LLM_BASE_URL: httpUrl.optional(),

  CHAT_PROVIDER: z.enum(LLM_PROVIDERS).optional(),
  LLM_CHAT_MODEL: nonEmpty.optional(),

  EMBEDDING_PROVIDER: z.enum(LLM_PROVIDERS).optional(),
  EMBEDDING_MODEL: nonEmpty.optional(),
  /**
   * The width of the vectors the configured embedding model returns.
   *
   * It must equal the `chunks.embedding` column's declared dimension. pgvector
   * needs a fixed width to build an HNSW index, so the column is
   * `vector(1024)` and a model that returns anything else cannot be stored —
   * the worker refuses the write and names this variable, rather than letting
   * a batch insert fail deep inside Postgres. Changing it means a migration
   * and a full reindex.
   */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(EMBEDDING_DIMENSIONS),
  /** How many passages go to the provider in one request. */
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().max(2048).default(64),

  RERANK_PROVIDER: z.enum(LLM_PROVIDERS).optional(),
  RERANK_MODEL: nonEmpty.optional(),

  VISION_PROVIDER: z.enum(LLM_PROVIDERS).optional(),
  VISION_MODEL: nonEmpty.optional(),

  OLLAMA_BASE_URL: httpUrl.default('http://localhost:11434'),
  /** vLLM serves whatever was loaded into it, so there is no default model. */
  VLLM_BASE_URL: httpUrl.optional(),

  /** Attempts per model call, the first included. */
  MODEL_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
  /** Per-call deadline for chat, rerank and vision. */
  MODEL_TIMEOUT_SECONDS: z.coerce.number().positive().default(60),
  /** Per-call deadline for one embedding batch, which is slower than one chat turn. */
  EMBEDDING_TIMEOUT_SECONDS: z.coerce.number().positive().default(120),
  /** Consecutive failures that open the circuit for a role. */
  MODEL_BREAKER_FAILURES: z.coerce.number().int().positive().default(5),
  /** How long an open circuit refuses calls before it tries one again. */
  MODEL_BREAKER_COOLDOWN_SECONDS: z.coerce.number().positive().default(30),

  /**
   * When true, any attempt to reach a non-local endpoint raises immediately.
   *
   * A headline claim of the project, not a convenience: legal, medical and
   * government users install Konusbitr precisely because a document cannot
   * leave the building. So it is enforced twice — once here, at boot, where a
   * cloud provider named for *any* role fails the process, and again at every
   * call site in the router, because an operator can also set it on a machine
   * whose configuration changes underneath a running process.
   */
  OFFLINE_MODE: z.stringbool().default(false),

  // ── Phase 08 — the chunker ───────────────────────────────────────────────
  //
  // Read by the worker, which is where chunking happens, but validated here
  // too: it is one `.env`, and a variable only one half knows about is a
  // variable that can be misspelled in the file the other half reads. The
  // defaults come from `CHUNKING_DEFAULTS` so the two runtimes cannot drift.
  CHUNK_TARGET_TOKENS: z.coerce.number().int().positive().default(CHUNKING_DEFAULTS.targetTokens),
  CHUNK_MIN_TOKENS: z.coerce.number().int().positive().default(CHUNKING_DEFAULTS.minTokens),
  CHUNK_MAX_TOKENS: z.coerce.number().int().positive().default(CHUNKING_DEFAULTS.maxTokens),
  CHUNK_OVERLAP_RATIO: z.coerce.number().min(0).max(0.5).default(CHUNKING_DEFAULTS.overlapRatio),

  // Billing.
  BILLING_ENABLED: z.stringbool().default(false),
  CREDITS_MODE: z.enum(CREDITS_MODES).default('unlimited'),
});

export type Env = z.infer<typeof EnvSchema>;

/** The variable that names a given role's provider, for error messages. */
const ROLE_PROVIDER_VARIABLE = {
  chat: 'CHAT_PROVIDER',
  embedding: 'EMBEDDING_PROVIDER',
  rerank: 'RERANK_PROVIDER',
  vision: 'VISION_PROVIDER',
} as const satisfies Record<ModelRole, string>;

/**
 * Which provider serves a role: its own variable, or `LLM_PROVIDER`.
 *
 * The fallback is what keeps the common case one variable. It is also why the
 * offline check below has to walk all four roles rather than looking at
 * `LLM_PROVIDER` alone — a deployment with `LLM_PROVIDER=ollama` and
 * `CHAT_PROVIDER=openai` is a cloud deployment, whatever the fallback says.
 */
export function roleProvider(env: Env, role: ModelRole): LlmProvider {
  switch (role) {
    case 'chat':
      return env.CHAT_PROVIDER ?? env.LLM_PROVIDER;
    case 'embedding':
      return env.EMBEDDING_PROVIDER ?? env.LLM_PROVIDER;
    case 'rerank':
      return env.RERANK_PROVIDER ?? env.LLM_PROVIDER;
    case 'vision':
      return env.VISION_PROVIDER ?? env.LLM_PROVIDER;
  }
}

/** The model name configured for a role, or `undefined` to take the default. */
export function roleModel(env: Env, role: ModelRole): string | undefined {
  switch (role) {
    case 'chat':
      return env.LLM_CHAT_MODEL;
    case 'embedding':
      return env.EMBEDDING_MODEL;
    case 'rerank':
      return env.RERANK_MODEL;
    case 'vision':
      return env.VISION_MODEL;
  }
}

/**
 * Whether a role has been configured at all.
 *
 * An unconfigured role is not an error. With no embedding model named, the
 * worker still chunks a document and stores the passages — they simply have no
 * vector until one is configured and a `reindex` runs, so retrieval is keyword
 * only. That is the same shape as `SMTP_URL` being unset: the feature degrades
 * to something coherent and says so, rather than failing a stack that an
 * operator has not finished configuring. A role that *is* configured and then
 * fails is a hard error, which is the distinction that matters.
 */
export function isRoleConfigured(env: Env, role: ModelRole): boolean {
  if (roleModel(env, role) !== undefined) return true;
  // A local provider needs no key, so naming one is enough to mean business;
  // a cloud provider without a key is the default `LLM_PROVIDER=openai` that
  // nobody has touched.
  const provider = roleProvider(env, role);
  return isLocalProvider(provider) ? true : env.LLM_API_KEY !== undefined;
}

/**
 * Cross-field rules that a per-variable schema cannot express.
 *
 * Kept as a wrapper rather than folded into `EnvSchema` so that `EnvSchema`
 * stays a plain object schema — `.shape` is read by the tests that assert the
 * two runtimes describe the same variables.
 */
export const EnvSchemaChecked = EnvSchema.check((ctx) => {
  const env = ctx.value;

  if (env.OFFLINE_MODE) {
    const cloudRoles = MODEL_ROLES.filter((role) =>
      (CLOUD_LLM_PROVIDERS as readonly LlmProvider[]).includes(roleProvider(env, role)),
    );

    if (cloudRoles.length > 0) {
      // Name only what the operator actually wrote. Every role inherits
      // `LLM_PROVIDER`, so listing all four would report three variables that
      // are not set as the cause of a mistake in one that is.
      const explicit = cloudRoles.filter((role) => env[ROLE_PROVIDER_VARIABLE[role]] !== undefined);
      const named = (
        explicit.length > 0
          ? explicit.map((role) => `${ROLE_PROVIDER_VARIABLE[role]}=${roleProvider(env, role)}`)
          : [`LLM_PROVIDER=${env.LLM_PROVIDER}`]
      ).join(', ');

      ctx.issues.push({
        code: 'custom',
        input: env.OFFLINE_MODE,
        path: ['OFFLINE_MODE'],
        message:
          `is true, but a cloud provider is configured (${named}). Offline mode ` +
          "means a document's text cannot leave this deployment, so every role " +
          `must name one of ${LOCAL_LLM_PROVIDERS.join(' or ')}. Refusing to ` +
          'start rather than quietly sending the first document to the internet.',
      });
    }

    if (env.LLM_BASE_URL !== undefined && !isLoopbackOrPrivate(env.LLM_BASE_URL)) {
      ctx.issues.push({
        code: 'custom',
        input: env.LLM_BASE_URL,
        path: ['LLM_BASE_URL'],
        message:
          `points at ${new URL(env.LLM_BASE_URL).hostname}, which is not a local ` +
          'address, and OFFLINE_MODE is true. An OpenAI-compatible proxy is still ' +
          'the internet if it is hosted on it.',
      });
    }
  }

  if (!providerCanEmbed(roleProvider(env, 'embedding')) && isRoleConfigured(env, 'embedding')) {
    ctx.issues.push({
      code: 'custom',
      input: roleProvider(env, 'embedding'),
      path: ['EMBEDDING_PROVIDER'],
      message:
        `is ${roleProvider(env, 'embedding')}, which has no embedding endpoint this ` +
        'router can address. Set EMBEDDING_PROVIDER to one that does — openai, ' +
        'mistral, ollama or vllm — and leave the chat role where it is.',
    });
  }

  if (env.CHUNK_MIN_TOKENS > env.CHUNK_TARGET_TOKENS) {
    ctx.issues.push({
      code: 'custom',
      input: env.CHUNK_MIN_TOKENS,
      path: ['CHUNK_MIN_TOKENS'],
      message: `is ${env.CHUNK_MIN_TOKENS}, above CHUNK_TARGET_TOKENS=${env.CHUNK_TARGET_TOKENS}`,
    });
  }

  if (env.CHUNK_MAX_TOKENS < env.CHUNK_TARGET_TOKENS) {
    ctx.issues.push({
      code: 'custom',
      input: env.CHUNK_MAX_TOKENS,
      path: ['CHUNK_MAX_TOKENS'],
      message: `is ${env.CHUNK_MAX_TOKENS}, below CHUNK_TARGET_TOKENS=${env.CHUNK_TARGET_TOKENS}`,
    });
  }
});

/**
 * Whether a URL resolves to something on this machine or this network.
 *
 * Hostname-shaped rather than DNS-resolving on purpose: this runs at boot, and
 * a boot check that waits on a resolver is a boot check that hangs. The real
 * SSRF-grade guard is `apps/web/src/lib/ingest/ssrf.ts`, which does resolve —
 * this one only has to refuse the obvious `https://api.openai.com` case, and a
 * self-hoster pointing offline mode at a private hostname gets the benefit of
 * the doubt they have earned by setting it.
 */
function isLoopbackOrPrivate(value: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    return false;
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '::1' || hostname === '[::1]') return true;
  // A bare Docker/Kubernetes service name has no dots and is therefore not a
  // public DNS name.
  if (!hostname.includes('.')) return true;

  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [a = 0, b = 0] = octets;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

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
  const result = EnvSchemaChecked.safeParse(candidate);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const name = String(issue.path[0] ?? '(root)');
    // A cross-field rule writes its own sentence and often fires on a variable
    // that was deliberately left at its default, so "is required but was not
    // set" would be both wrong and unhelpful.
    const detail =
      issue.code === 'custom' || name in candidate ? issue.message : 'is required but was not set';
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
