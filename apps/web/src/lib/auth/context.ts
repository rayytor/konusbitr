import { findApiKeysByPrefix, scopedDb, touchApiKey as writeLastUsed } from '@konusbitr/db';
import { db } from '../db';
import { redis } from '../redis';
import { apiKeyPrefix, looksLikeApiKey, verifyApiKey } from './api-key';
import { auth } from './config';
import { ALL_SCOPES, type ApiScope, sanitizeScopes } from './scopes';

/**
 * The one thing every protected request resolves to.
 *
 * Konusbitr has two front doors — the web app's session cookie and the `/v2`
 * API's `X-API-Key` header — and both land here. Handlers below this point
 * never ask *how* the caller authenticated; they ask which organization the
 * request belongs to and what it is allowed to do. That is what lets Phase 13
 * expose the same handlers publicly without a second authorization story.
 */
export type MembershipRole = 'owner' | 'admin' | 'member';

export type AuthContext = {
  kind: 'session' | 'apiKey';
  /** Absent for API-key principals: a key belongs to an org, not to a person. */
  userId?: string;
  orgId: string;
  role: MembershipRole;
  /** API keys carry the scopes they were issued with; sessions carry all of them. */
  scopes: readonly ApiScope[];
  /** Present for API-key principals, for audit logging and revocation. */
  apiKeyId?: string;
};

/** Why a request could not be authenticated. Never surfaced verbatim to a client. */
export type AuthFailure =
  | 'no-credentials'
  | 'invalid-api-key'
  | 'revoked-api-key'
  | 'expired-api-key'
  | 'no-session'
  | 'no-organization';

export type AuthResolution =
  | { ok: true; context: AuthContext }
  | { ok: false; reason: AuthFailure };

/**
 * An API key acts with the least-privileged role.
 *
 * A key has no user behind it, so it cannot be an `owner` or an `admin`: it
 * must not be able to delete the organization, change billing, or mint more
 * keys. Its real authorization surface is its scopes, checked per endpoint.
 */
const API_KEY_ROLE: MembershipRole = 'member';

/**
 * `last_used_at` is written at most once a minute per key.
 *
 * Without the guard, every authenticated API request would carry a write to a
 * hot row — on a busy key that is a lock convoy in exchange for a timestamp
 * nobody reads at second granularity. The guard is best-effort: if Redis is
 * unavailable the touch is skipped, never the request.
 */
const TOUCH_INTERVAL_SECONDS = 60;

async function touchApiKey(keyId: string): Promise<void> {
  try {
    const fresh = await redis().set(
      `apikey:touched:${keyId}`,
      '1',
      'EX',
      TOUCH_INTERVAL_SECONDS,
      'NX',
    );
    if (fresh !== 'OK') return;
    await writeLastUsed(db(), keyId);
  } catch {
    // A timestamp is not worth failing an authenticated request over.
  }
}

/** Resolve an `X-API-Key` header to a principal. */
export async function resolveApiKey(presented: string): Promise<AuthResolution> {
  if (!looksLikeApiKey(presented)) return { ok: false, reason: 'invalid-api-key' };

  // Narrowed by the non-secret prefix, then compared in constant time. The
  // prefix is indexed, so this is a handful of rows at most.
  const candidates = await findApiKeysByPrefix(db(), apiKeyPrefix(presented));

  const match = candidates.find((row) => verifyApiKey(presented, row.hashedKey));
  if (!match) return { ok: false, reason: 'invalid-api-key' };
  if (match.revokedAt) return { ok: false, reason: 'revoked-api-key' };
  if (match.expiresAt && match.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired-api-key' };
  }

  await touchApiKey(match.id);

  return {
    ok: true,
    context: {
      kind: 'apiKey',
      orgId: match.orgId,
      role: API_KEY_ROLE,
      scopes: sanitizeScopes(match.scopes),
      apiKeyId: match.id,
    },
  };
}

/** Resolve a session cookie to a principal. */
export async function resolveSession(headers: Headers): Promise<AuthResolution> {
  const session = await auth().api.getSession({ headers });
  if (!session) return { ok: false, reason: 'no-session' };

  const orgId = session.session.activeOrganizationId;
  const userId = session.user.id;

  // A session always carries an active organization — `databaseHooks` sets one
  // when the session is created — but a membership can be revoked underneath a
  // live session, so the membership is what actually authorizes the request.
  const membership = orgId ? await scopedDb(db(), orgId).membershipOf(userId) : undefined;

  if (!orgId || !membership) return { ok: false, reason: 'no-organization' };

  return {
    ok: true,
    context: { kind: 'session', userId, orgId, role: membership.role, scopes: ALL_SCOPES },
  };
}

/**
 * Resolve a request to an {@link AuthContext}.
 *
 * Order is `X-API-Key` first, then the session cookie. A request that presents
 * a key is judged on that key alone: falling back to the browser session of
 * whoever happens to be signed in would let a revoked key keep working from a
 * logged-in browser.
 */
export async function resolveAuthContext(request: Request): Promise<AuthResolution> {
  const presented = request.headers.get('x-api-key');
  if (presented) return resolveApiKey(presented.trim());
  return resolveSession(request.headers);
}

/** Whether the role is at least as privileged as the one required. */
const ROLE_RANK: Record<MembershipRole, number> = { member: 0, admin: 1, owner: 2 };

export function hasRole(role: MembershipRole, required: MembershipRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}
