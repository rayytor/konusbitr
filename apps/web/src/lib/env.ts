import { EnvSchema, EnvValidationError } from '@konusbitr/shared';
import { z } from 'zod';

/**
 * The web app's environment: the cross-runtime contract from
 * `@konusbitr/shared`, plus the variables only the Next.js server reads.
 *
 * Auth configuration lives here rather than in `@konusbitr/shared` on purpose.
 * That schema is one half of a two-runtime contract — the Python worker
 * validates the same variables with pydantic-settings — and the worker has no
 * business knowing a session-signing secret. Splitting the schema keeps the
 * contract honest: what is in `shared` is genuinely shared.
 *
 * Like the shared half, this fails loudly at boot from `instrumentation.ts`,
 * never lazily at first use.
 */

/**
 * The value `.env.example` ships so that `cp .env.example .env && docker
 * compose up` needs no further edits. It is fine on a laptop and catastrophic
 * on the internet, so production refuses to start with it.
 */
export const DEVELOPMENT_AUTH_SECRET = 'konusbitr-development-secret-change-me';

const nonEmpty = z.string().trim().min(1);

/**
 * A social provider is configured only when *both* halves are present. A
 * self-hoster with no OAuth app must still get a working login, so half a
 * configuration is a boot-time error rather than a login page that throws when
 * someone clicks the button.
 */
const oauthPair = z
  .object({ clientId: nonEmpty.optional(), clientSecret: nonEmpty.optional() })
  .refine((value) => Boolean(value.clientId) === Boolean(value.clientSecret), {
    message: 'set both the client id and the client secret, or neither',
  });

export const WebEnvSchema = EnvSchema.extend({
  /**
   * Signs session cookies and every short-lived token. Rotating it logs
   * everyone out, which is the intended behaviour after a leak.
   */
  AUTH_SECRET: z
    .string()
    .trim()
    .min(32, {
      message: 'must be at least 32 characters — generate with `openssl rand -base64 32`',
    }),

  GOOGLE_CLIENT_ID: nonEmpty.optional(),
  GOOGLE_CLIENT_SECRET: nonEmpty.optional(),
  GITHUB_CLIENT_ID: nonEmpty.optional(),
  GITHUB_CLIENT_SECRET: nonEmpty.optional(),

  /**
   * An SMTP connection string. When it is absent, verification and magic-link
   * URLs are written to the server log instead — which is what a self-hoster
   * on localhost actually wants, and is why signup works out of the box.
   */
  SMTP_URL: nonEmpty.optional(),
  EMAIL_FROM: z.string().trim().min(3).default('Konusbitr <no-reply@localhost>'),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV === 'production' && value.AUTH_SECRET === DEVELOPMENT_AUTH_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_SECRET'],
      message:
        'is still the development value from .env.example — generate a real one with `openssl rand -base64 32`',
    });
  }

  const pairs = [
    ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
  ] as const;

  for (const [idKey, secretKey] of pairs) {
    const result = oauthPair.safeParse({ clientId: value[idKey], clientSecret: value[secretKey] });
    if (!result.success) {
      ctx.addIssue({
        code: 'custom',
        path: [idKey],
        message: 'set both the client id and the client secret, or neither',
      });
    }
  }
});

export type WebEnv = z.infer<typeof WebEnvSchema>;

/** Variables that are present but empty are treated as absent, not as `''`. */
function withoutBlanks(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') out[key] = value;
  }
  return out;
}

/**
 * Validate the web app's environment, raising the same
 * {@link EnvValidationError} the shared half raises so that
 * `instrumentation.ts` has one thing to catch and one shape to print.
 */
export function parseWebEnv(source: Record<string, string | undefined>): WebEnv {
  const candidate = withoutBlanks(source);
  const result = WebEnvSchema.safeParse(candidate);
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

let cached: WebEnv | undefined;

/** The process-wide web environment. Memoized; safe to call from anywhere. */
export function loadWebEnv(source: Record<string, string | undefined> = process.env): WebEnv {
  cached ??= parseWebEnv(source);
  return cached;
}

/** Test-only: drop the memoized value so a fresh source can be parsed. */
export function resetWebEnvCache(): void {
  cached = undefined;
}
