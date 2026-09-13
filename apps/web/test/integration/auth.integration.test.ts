import { randomUUID } from 'node:crypto';
import {
  createDb,
  type Database,
  findApiKeysByPrefix,
  migrate,
  organizationsOf,
  scopedDb,
} from '@konusbitr/db';
import { ensureExtensions, organizationExists, userByEmail } from '@konusbitr/db/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey, verifyApiKey } from '@/lib/auth/api-key';
import { createAuth } from '@/lib/auth/config';
import { createRedisRateLimiter } from '@/lib/auth/rate-limit';
import { missingScope } from '@/lib/auth/scopes';
import { DEVELOPMENT_AUTH_SECRET, parseWebEnv } from '@/lib/env';

/**
 * Phase 04's acceptance criteria, against a real Postgres and a real Redis.
 *
 * These run against a live Better Auth instance rather than a mock on purpose.
 * The whole risk of mapping Better Auth onto Phase 03's tables is that the
 * Drizzle adapter resolves model and field names by *string* at runtime: a
 * typo in `config.ts` typechecks perfectly and fails on the first sign-up.
 * Nothing short of executing the real thing catches that.
 */

const APP_URL = 'http://localhost:3000';

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let db: Database;
let redis: Redis;
let auth: ReturnType<typeof createAuth>;

/** Every email delivered during the run, so link-based flows can be followed. */
const outbox: { to: string; subject: string; url: string }[] = [];

function lastLinkTo(email: string): string {
  const message = [...outbox].reverse().find((entry) => entry.to === email);
  if (!message) throw new Error(`no email was sent to ${email}`);
  return message.url;
}

beforeAll(async () => {
  const [{ PostgreSqlContainer }, { RedisContainer }] = await Promise.all([
    import('@testcontainers/postgresql'),
    import('@testcontainers/redis'),
  ]);

  [postgres, redisContainer] = await Promise.all([
    new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  const databaseUrl = postgres.getConnectionUri();
  db = createDb(databaseUrl);

  await ensureExtensions(db);
  await migrate(databaseUrl);

  redis = new Redis(redisContainer.getConnectionUrl(), { maxRetriesPerRequest: null });

  const env = parseWebEnv({
    NODE_ENV: 'test',
    APP_URL,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisContainer.getConnectionUrl(),
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'konusbitr',
    S3_ACCESS_KEY_ID: 'konusbitr',
    S3_SECRET_ACCESS_KEY: 'konusbitr-dev-secret',
    AUTH_SECRET: DEVELOPMENT_AUTH_SECRET,
  });

  auth = createAuth({
    env,
    database: db,
    rateLimiter: createRedisRateLimiter(redis),
    mail: {
      send: async (message) => {
        outbox.push({ to: message.to, subject: message.subject, url: message.url });
      },
    },
  });
}, 180_000);

afterAll(async () => {
  redis?.disconnect();
  await Promise.all([postgres?.stop(), redisContainer?.stop()]);
}, 60_000);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uniqueEmail(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}@konusbitr.test`;
}

/** Sign up, follow the verification link, and return a usable session cookie. */
async function signUpAndVerify(email: string, name = 'Test Person'): Promise<string> {
  await auth.api.signUpEmail({
    body: { email, password: 'a-long-enough-password', name },
    asResponse: true,
  });

  // Verification is required, so the session only exists after the link is used.
  const response = await auth.handler(new Request(lastLinkTo(email), { redirect: 'manual' }));
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error(`verifying ${email} did not produce a session`);
  return cookie.split(';')[0] ?? '';
}

function headersWith(cookie: string): Headers {
  return new Headers({ cookie, origin: APP_URL });
}

async function userIdFor(email: string): Promise<string> {
  const row = await userByEmail(db, email);
  if (!row) throw new Error(`no user row for ${email}`);
  return row.id;
}

// ─── Signup, verification and the personal organization ──────────────────────

describe('signup', () => {
  it('verifies by email and lands the user in exactly one organization', async () => {
    const email = uniqueEmail('owner');
    const cookie = await signUpAndVerify(email, 'Ada Lovelace');

    const session = await auth.api.getSession({ headers: headersWith(cookie) });
    expect(session?.user.email).toBe(email);
    expect(session?.user.emailVerified).toBe(true);

    const userId = await userIdFor(email);
    const orgs = await organizationsOf(db, userId);

    expect(orgs).toHaveLength(1);
    expect(orgs[0]?.role).toBe('owner');

    // And the session opens in that organization, which is what every later
    // request scopes to.
    expect(session?.session.activeOrganizationId).toBe(orgs[0]?.id);
  });

  it('refuses to sign in before the email is verified', async () => {
    const email = uniqueEmail('unverified');
    await auth.api.signUpEmail({
      body: { email, password: 'a-long-enough-password', name: 'Unverified' },
      asResponse: true,
    });

    const response = await auth.api.signInEmail({
      body: { email, password: 'a-long-enough-password' },
      asResponse: true,
    });

    expect(response.status).toBe(403);
  });

  it('gives the organization a readable slug derived from the name', async () => {
    const email = uniqueEmail('slug');
    await signUpAndVerify(email, 'Grace Hopper');

    const [org] = await organizationsOf(db, await userIdFor(email));
    expect(org?.slug).toMatch(/^grace-hopper/);
  });
});

// ─── Sign-in and sign-out ────────────────────────────────────────────────────

describe('sign-in', () => {
  it('completes the password round trip and then invalidates the session', async () => {
    const email = uniqueEmail('roundtrip');
    await signUpAndVerify(email);

    const signedIn = await auth.api.signInEmail({
      body: { email, password: 'a-long-enough-password' },
      asResponse: true,
    });
    const cookie = signedIn.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(await auth.api.getSession({ headers: headersWith(cookie) })).not.toBeNull();

    await auth.api.signOut({ headers: headersWith(cookie) });
    expect(await auth.api.getSession({ headers: headersWith(cookie) })).toBeNull();
  });

  it('signs in through a magic link', async () => {
    const email = uniqueEmail('magic');
    await signUpAndVerify(email);
    outbox.length = 0;

    await auth.api.signInMagicLink({
      body: { email },
      headers: new Headers({ origin: APP_URL }),
      asResponse: true,
    });

    const response = await auth.handler(new Request(lastLinkTo(email), { redirect: 'manual' }));
    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';

    const session = await auth.api.getSession({ headers: headersWith(cookie) });
    expect(session?.user.email).toBe(email);
  });

  it('signs in as a guest, creates an organization and sets the session cookie', async () => {
    const response = await auth.handler(
      new Request(`${APP_URL}/api/auth/sign-in/guest`, {
        method: 'POST',
        headers: new Headers({ origin: APP_URL }),
      }),
    );

    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();

    const cookie = setCookie?.split(';')[0] ?? '';
    const session = await auth.api.getSession({ headers: headersWith(cookie) });

    expect(session).toBeDefined();
    if (!session) throw new Error('no session returned');
    expect(session.user.email).toMatch(/^guest-[a-f0-9]+@konusbitr\.local$/);
    expect(session.user.emailVerified).toBe(true);

    const orgs = await organizationsOf(db, session.user.id);
    expect(orgs).toHaveLength(1);
    expect(orgs[0]?.role).toBe('owner');
    expect(session.session.activeOrganizationId).toBe(orgs[0]?.id);
  });
});

// ─── API keys ────────────────────────────────────────────────────────────────

describe('API keys', () => {
  it('authenticates, then stops the moment it is revoked', async () => {
    const email = uniqueEmail('keys');
    const cookie = await signUpAndVerify(email);
    const session = await auth.api.getSession({ headers: headersWith(cookie) });
    const orgId = session?.session.activeOrganizationId ?? '';
    const scoped = scopedDb(db, orgId);

    const generated = generateApiKey();
    const key = await scoped.createApiKey({
      name: 'CI',
      hashedKey: generated.hashedKey,
      prefix: generated.prefix,
      scopes: ['documents:read', 'chat'],
    });

    // What `resolveApiKey` does: narrow by prefix, then compare in constant time.
    const candidates = await findApiKeysByPrefix(db, generated.prefix);
    const matched = candidates.find((row) => verifyApiKey(generated.token, row.hashedKey));
    expect(matched?.id).toBe(key?.id);
    expect(matched?.orgId).toBe(orgId);
    expect(matched?.revokedAt).toBeNull();

    await scoped.revokeApiKey(key?.id ?? '');

    const afterRevocation = await findApiKeysByPrefix(db, generated.prefix);
    const stillMatches = afterRevocation.find((row) =>
      verifyApiKey(generated.token, row.hashedKey),
    );
    // The hash still matches — revocation is what rejects it.
    expect(stillMatches).toBeDefined();
    expect(stillMatches?.revokedAt).not.toBeNull();
  });

  it('names the scope a key is missing', async () => {
    const email = uniqueEmail('scoped-key');
    const cookie = await signUpAndVerify(email);
    const session = await auth.api.getSession({ headers: headersWith(cookie) });
    const scoped = scopedDb(db, session?.session.activeOrganizationId ?? '');

    const generated = generateApiKey();
    await scoped.createApiKey({
      name: 'Read only',
      hashedKey: generated.hashedKey,
      prefix: generated.prefix,
      scopes: ['documents:read'],
    });

    const [stored] = await findApiKeysByPrefix(db, generated.prefix);
    expect(missingScope(stored?.scopes ?? [], ['documents:read'])).toBeNull();
    expect(missingScope(stored?.scopes ?? [], ['documents:write'])).toBe('documents:write');
  });

  it('cannot be revoked from another organization', async () => {
    const [mine, theirs] = await Promise.all([
      signUpAndVerify(uniqueEmail('org-a')),
      signUpAndVerify(uniqueEmail('org-b')),
    ]);

    const mineOrg =
      (await auth.api.getSession({ headers: headersWith(mine) }))?.session.activeOrganizationId ??
      '';
    const theirsOrg =
      (await auth.api.getSession({ headers: headersWith(theirs) }))?.session.activeOrganizationId ??
      '';

    const generated = generateApiKey();
    const key = await scopedDb(db, mineOrg).createApiKey({
      name: 'Mine',
      hashedKey: generated.hashedKey,
      prefix: generated.prefix,
      scopes: ['chat'],
    });

    // The org predicate in `revokeApiKey` is what stops this, not an id guess.
    expect(await scopedDb(db, theirsOrg).revokeApiKey(key?.id ?? '')).toBeUndefined();
    expect(await scopedDb(db, mineOrg).revokeApiKey(key?.id ?? '')).toBeDefined();
  });
});

// ─── Roles ───────────────────────────────────────────────────────────────────

describe('roles', () => {
  it('lets an owner delete the organization and refuses an admin', async () => {
    const ownerCookie = await signUpAndVerify(uniqueEmail('deleter'));
    const ownerSession = await auth.api.getSession({ headers: headersWith(ownerCookie) });
    const orgId = ownerSession?.session.activeOrganizationId ?? '';

    // A second person, promoted to admin in the owner's organization.
    const adminEmail = uniqueEmail('admin');
    const adminCookie = await signUpAndVerify(adminEmail);

    await auth.api.addMember({
      body: { userId: await userIdFor(adminEmail), role: 'admin', organizationId: orgId },
    });
    await auth.api.setActiveOrganization({
      body: { organizationId: orgId },
      headers: headersWith(adminCookie),
    });

    const refused = await auth.api.deleteOrganization({
      body: { organizationId: orgId },
      headers: headersWith(adminCookie),
      asResponse: true,
    });
    expect(refused.ok).toBe(false);

    const allowed = await auth.api.deleteOrganization({
      body: { organizationId: orgId },
      headers: headersWith(ownerCookie),
      asResponse: true,
    });
    expect(allowed.ok).toBe(true);

    expect(await organizationExists(db, orgId)).toBe(false);
  });
});

// ─── Invitations ─────────────────────────────────────────────────────────────

describe('invitations', () => {
  it('adds the invitee as a member once they accept', async () => {
    const ownerCookie = await signUpAndVerify(uniqueEmail('inviter'), 'Inviter');
    const orgId =
      (await auth.api.getSession({ headers: headersWith(ownerCookie) }))?.session
        .activeOrganizationId ?? '';

    const inviteeEmail = uniqueEmail('invitee');
    const inviteeCookie = await signUpAndVerify(inviteeEmail);

    const invitation = await auth.api.createInvitation({
      body: { email: inviteeEmail, role: 'member', organizationId: orgId },
      headers: headersWith(ownerCookie),
    });

    expect(await scopedDb(db, orgId).pendingInvitations()).toHaveLength(1);

    await auth.api.acceptInvitation({
      body: { invitationId: invitation.id },
      headers: headersWith(inviteeCookie),
    });

    const members = await scopedDb(db, orgId).members();
    expect(members.map((member) => member.email)).toContain(inviteeEmail);
    expect(members.find((member) => member.email === inviteeEmail)?.role).toBe('member');
    expect(await scopedDb(db, orgId).pendingInvitations()).toHaveLength(0);
  });
});

// ─── Rate limiting ───────────────────────────────────────────────────────────

describe('rate limiting', () => {
  it('trips when login is brute-forced', async () => {
    const email = uniqueEmail('bruteforce');
    await signUpAndVerify(email);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await auth.handler(
        new Request(`${APP_URL}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
          body: JSON.stringify({ email, password: `wrong-password-${attempt}` }),
        }),
      );
      statuses.push(response.status);
    }

    // The rule is ten a minute, so a burst of twenty-five must hit 429.
    expect(statuses).toContain(429);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(10);
  });

  it('runs the bucket in Redis, atomically', async () => {
    const limiter = createRedisRateLimiter(redis);
    const key = `test:bucket:${randomUUID()}`;
    const rule = { window: 60, max: 5 };

    // Twenty concurrent consumers of a five-token bucket: exactly five succeed.
    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.consume(key, rule)));

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.find((result) => !result.allowed)?.retryAfter).toBeGreaterThan(0);
  });
});
