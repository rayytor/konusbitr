import {
  type Database,
  firstOrganizationOf,
  ID_PREFIXES,
  memberships,
  newId,
  organizations,
} from '@konusbitr/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { magicLink } from 'better-auth/plugins/magic-link';
import { organization } from 'better-auth/plugins/organization';
import { db } from '../db';
import { isSecureOrigin, loadWebEnv, type WebEnv } from '../env';
import { redis } from '../redis';
import { mailer } from './email';
import { guestPlugin } from './guest';
import { createRedisRateLimiter } from './rate-limit';
import * as tables from './tables';

/**
 * Better Auth, pointed at Konusbitr's own tables.
 *
 * The mapping below is the load-bearing part of this file. Better Auth names
 * its models `user`, `session`, `member`; Phase 03 named the tables `users`,
 * `sessions`, `memberships`, and `memberships` calls the column `org_id`, not
 * `organization_id`. The Drizzle adapter resolves both by *string lookup* at
 * runtime, so a mismatch here is a 500 on sign-in rather than a type error.
 * `test/integration/auth.integration.test.ts` exercises every mapped model
 * against a real Postgres for exactly that reason.
 */

/**
 * Model name → id prefix. Ids are ours, not Better Auth's, so that a `ses_…` in
 * a log is unambiguously a session. Both spellings are listed because the
 * canonical model name is what reaches `generateId`, while the mapped name is
 * what appears elsewhere.
 */
const ID_PREFIX_BY_MODEL: Record<string, string> = {
  user: ID_PREFIXES.user,
  users: ID_PREFIXES.user,
  session: ID_PREFIXES.session,
  sessions: ID_PREFIXES.session,
  account: ID_PREFIXES.account,
  accounts: ID_PREFIXES.account,
  verification: ID_PREFIXES.verification,
  verifications: ID_PREFIXES.verification,
  organization: ID_PREFIXES.organization,
  organizations: ID_PREFIXES.organization,
  member: ID_PREFIXES.membership,
  memberships: ID_PREFIXES.membership,
  invitation: ID_PREFIXES.invitation,
  invitations: ID_PREFIXES.invitation,
};

/** A URL-safe, human-readable slug seed for a personal organization. */
function slugSeed(input: string): string {
  const seed = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return seed || 'workspace';
}

/**
 * Give a brand-new user the organization they will own.
 *
 * Every row the product stores hangs off an `org_id`, so a user without an
 * organization has nowhere to put a document. Creating it in the same
 * transaction-adjacent moment as the user is what makes "a new signup owns
 * exactly one organization" true regardless of which front door they came
 * through — password, magic link or OAuth.
 *
 * The slug retries on collision rather than being derived from the id, because
 * it is a user-facing handle and `acme` reads better than `org_clx…`.
 */
async function createPersonalOrganization(
  database: Database,
  user: { id: string; name?: string | null; email: string },
): Promise<string> {
  const name = user.name?.trim() || user.email.split('@')[0] || 'Workspace';
  const seed = slugSeed(name);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? seed : `${seed}-${newId('x').slice(2, 8)}`;
    const orgId = newId(ID_PREFIXES.organization);

    const inserted = await database
      .insert(organizations)
      .values({ id: orgId, name, slug })
      .onConflictDoNothing({ target: organizations.slug })
      .returning({ id: organizations.id });

    if (inserted.length === 0) continue;

    await database.insert(memberships).values({ userId: user.id, orgId, role: 'owner' });
    return orgId;
  }

  throw new Error(`could not allocate an organization slug for user ${user.id}`);
}

/**
 * Only configured providers are handed to Better Auth.
 *
 * A self-hoster with no OAuth app must get a login page that works, so an
 * absent `GOOGLE_CLIENT_ID` means "no Google button", never a half-initialised
 * provider that throws when someone clicks it. `env.ts` already rejects half a
 * pair at boot, so presence of the id implies presence of the secret.
 */
export function socialProvidersFor(env: WebEnv) {
  return {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
      : {}),
    ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
      : {}),
  };
}

/** Which social buttons the login page should render. */
export function enabledSocialProviders(env: WebEnv = loadWebEnv()): ('google' | 'github')[] {
  return Object.keys(socialProvidersFor(env)) as ('google' | 'github')[];
}

export type CreateAuthOptions = {
  env: WebEnv;
  database: Database;
  /** Rate-limit storage. Injectable so tests can run without Redis. */
  rateLimiter: {
    consume: (
      key: string,
      rule: { window: number; max: number },
    ) => Promise<{ allowed: boolean; retryAfter: number | null }>;
  };
  mail: {
    send: (message: { to: string; subject: string; url: string; body: string }) => Promise<void>;
  };
};

/**
 * Build a Better Auth instance.
 *
 * Exported as a factory, not just as the singleton below, so that integration
 * tests can point a real instance at a throwaway Postgres without touching
 * process-wide state.
 */
export function createAuth({ env, database, rateLimiter, mail }: CreateAuthOptions) {
  return betterAuth({
    appName: 'Konusbitr',
    baseURL: env.APP_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.APP_URL],

    database: drizzleAdapter(database, { provider: 'pg', schema: tables.authSchema }),

    user: { modelName: 'users' },
    session: {
      modelName: 'sessions',
      // A week, refreshed once a day of use. Long enough that a working session
      // is not interrupted, short enough that a stolen cookie expires.
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    account: { modelName: 'accounts' },
    verification: { modelName: 'verifications' },

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      sendResetPassword: async ({ user, url }) => {
        await mail.send({
          to: user.email,
          subject: 'Reset your Konusbitr password',
          url,
          body: 'Use the link below to choose a new password. It expires in an hour.',
        });
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await mail.send({
          to: user.email,
          subject: 'Verify your Konusbitr email',
          url,
          body: 'Confirm this address to finish setting up your Konusbitr account.',
        });
      },
    },

    socialProviders: socialProvidersFor(env),

    advanced: {
      // Follows the origin, not NODE_ENV: the Compose container is a
      // production build serving plain HTTP on localhost, and a browser drops
      // a `__Secure-` cookie that did not arrive over HTTPS.
      useSecureCookies: isSecureOrigin(env.APP_URL),
      database: {
        generateId: ({ model }) => newId(ID_PREFIX_BY_MODEL[model] ?? 'id'),
      },
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
      },
    },

    /**
     * Rate limiting is on in every environment, not just production, because a
     * limiter that only runs in production is a limiter nobody has tested.
     * The four rules below are the unauthenticated front doors.
     */
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customStorage: { consume: (key, rule) => rateLimiter.consume(key, rule) },
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60 * 60, max: 10 },
        '/sign-in/magic-link': { window: 60 * 10, max: 5 },
        '/sign-in/guest': { window: 60, max: 15 },
        '/organization/accept-invitation': { window: 60 * 10, max: 10 },
      },
    },

    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await createPersonalOrganization(database, user);
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            // Resolving the active organization here — rather than on first use
            // — is what lets `resolveAuthContext` treat `orgId` as present for
            // the whole life of the session.
            const orgId = await firstOrganizationOf(database, session.userId);
            return orgId ? { data: { ...session, activeOrganizationId: orgId } } : undefined;
          },
        },
      },
    },

    plugins: [
      magicLink({
        expiresIn: 60 * 10,
        // Tokens are hashed at rest, so a leaked database backup does not hand
        // the reader a working sign-in link.
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          await mail.send({
            to: email,
            subject: 'Your Konusbitr sign-in link',
            url,
            body: 'Use the link below to sign in. It expires in ten minutes and works once.',
          });
        },
      }),

      organization({
        creatorRole: 'owner',
        // Roles are the product's own three. `owner` can delete the
        // organization and manage billing, `admin` can manage members, API keys
        // and settings, `member` gets documents and chats. The plugin's default
        // access control already encodes exactly that split.
        schema: {
          organization: { modelName: 'organizations' },
          member: { modelName: 'memberships', fields: { organizationId: 'orgId' } },
          invitation: { modelName: 'invitations', fields: { organizationId: 'orgId' } },
        },
        invitationExpiresIn: 60 * 60 * 24 * 7,
        sendInvitationEmail: async ({ id, email, organization: org, inviter }) => {
          await mail.send({
            to: email,
            subject: `Join ${org.name} on Konusbitr`,
            url: `${env.APP_URL}/accept-invitation/${id}`,
            body: `${inviter.user.name || inviter.user.email} invited you to the ${org.name} workspace.`,
          });
        },
      }),

      guestPlugin(),

      // Must stay last: it wraps the handlers that came before so that
      // `Set-Cookie` survives a server action.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as typeof globalThis & { konusbitrAuth?: Auth };

/** The process-wide Better Auth instance. */
export function auth(): Auth {
  globalForAuth.konusbitrAuth ??= createAuth({
    env: loadWebEnv(),
    database: db(),
    rateLimiter: createRedisRateLimiter(redis()),
    mail: mailer(),
  });
  return globalForAuth.konusbitrAuth;
}
