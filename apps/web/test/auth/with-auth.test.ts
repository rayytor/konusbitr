import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext, AuthResolution } from '@/lib/auth/context';

/**
 * `withAuth` in isolation.
 *
 * The resolver is mocked so that these assertions are about the *policy* —
 * what a missing scope returns, what a wrong origin returns, what a key is
 * refused — rather than about the database. The resolver itself is exercised
 * for real in `test/integration/auth.integration.test.ts`.
 */
const APP_URL = 'http://localhost:3000';

const resolveAuthContext = vi.fn<(request: Request) => Promise<AuthResolution>>();

vi.mock('@/lib/auth/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/context')>()),
  resolveAuthContext: (request: Request) => resolveAuthContext(request),
}));

vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env')>()),
  loadWebEnv: () => ({ APP_URL, NODE_ENV: 'test' }),
}));

const { withAuth } = await import('@/lib/auth/with-auth');

function sessionContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    kind: 'session',
    userId: 'usr_1',
    orgId: 'org_1',
    role: 'member',
    scopes: ['parse', 'extract', 'split', 'ask', 'chat', 'documents:read', 'documents:write'],
    ...overrides,
  };
}

function apiKeyContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    kind: 'apiKey',
    orgId: 'org_1',
    role: 'member',
    scopes: ['documents:read'],
    apiKeyId: 'key_1',
    ...overrides,
  };
}

/** A handler that reports the context it was handed, so leakage is visible. */
const echo = withAuth((_request, auth) => Response.json({ orgId: auth.orgId, kind: auth.kind }));

const noParams = { params: Promise.resolve({}) };

function get(headers: Record<string, string> = {}) {
  return new Request(`${APP_URL}/api/thing`, { headers });
}

function post(headers: Record<string, string> = {}) {
  return new Request(`${APP_URL}/api/thing`, { method: 'POST', headers });
}

beforeEach(() => resolveAuthContext.mockReset());

describe('when the request cannot be authenticated', () => {
  it.each([
    'no-credentials',
    'invalid-api-key',
    'revoked-api-key',
    'expired-api-key',
    'no-session',
    'no-organization',
  ] as const)('returns an indistinguishable 401 for %s', async (reason) => {
    resolveAuthContext.mockResolvedValue({ ok: false, reason });

    const response = await echo(get(), noParams);
    expect(response.status).toBe(401);

    // Telling a caller their key was *revoked* rather than wrong confirms the
    // key existed, so every failure reads the same.
    const body = await response.json();
    expect(body.error.code).toBe('unauthorized');
    expect(JSON.stringify(body)).not.toContain(reason);
  });

  it('never calls the handler', async () => {
    const handler = vi.fn(() => Response.json({}));
    resolveAuthContext.mockResolvedValue({ ok: false, reason: 'no-session' });

    await withAuth(handler)(get(), noParams);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('scopes', () => {
  it('names the missing scope in a 403', async () => {
    resolveAuthContext.mockResolvedValue({ ok: true, context: apiKeyContext() });

    const route = withAuth(() => Response.json({}), { scopes: ['documents:write'] });
    const response = await route(get(), noParams);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('missing_scope');
    expect(body.error.message).toContain('documents:write');
    expect(body.error.scope).toBe('documents:write');
  });

  it('lets a key through when it holds the scope', async () => {
    resolveAuthContext.mockResolvedValue({ ok: true, context: apiKeyContext() });

    const route = withAuth(() => Response.json({ ok: true }), { scopes: ['documents:read'] });
    expect((await route(get(), noParams)).status).toBe(200);
  });

  it('lets a session through whatever the route requires', async () => {
    resolveAuthContext.mockResolvedValue({ ok: true, context: sessionContext() });

    const route = withAuth(() => Response.json({ ok: true }), {
      scopes: ['documents:write', 'chat'],
    });
    expect((await route(get(), noParams)).status).toBe(200);
  });
});

describe('roles', () => {
  it('refuses a member on an admin route, naming both roles', async () => {
    resolveAuthContext.mockResolvedValue({ ok: true, context: sessionContext({ role: 'member' }) });

    const route = withAuth(() => Response.json({}), { role: 'admin' });
    const response = await route(get(), noParams);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('insufficient_role');
    expect(body.error.requiredRole).toBe('admin');
    expect(body.error.role).toBe('member');
  });

  it('treats owner as outranking admin', async () => {
    resolveAuthContext.mockResolvedValue({ ok: true, context: sessionContext({ role: 'owner' }) });

    const route = withAuth(() => Response.json({ ok: true }), { role: 'admin' });
    expect((await route(get(), noParams)).status).toBe(200);
  });

  it('refuses an admin on an owner route', async () => {
    resolveAuthContext.mockResolvedValue({ ok: true, context: sessionContext({ role: 'admin' }) });

    const route = withAuth(() => Response.json({}), { role: 'owner' });
    expect((await route(get(), noParams)).status).toBe(403);
  });
});

describe('API keys on account-management routes', () => {
  it('are refused with an explanation', async () => {
    resolveAuthContext.mockResolvedValue({ ok: true, context: apiKeyContext() });

    const route = withAuth(() => Response.json({}), { allowApiKey: false });
    const response = await route(get(), noParams);

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('session_required');
  });

  it('do not block the session principal those routes are for', async () => {
    resolveAuthContext.mockResolvedValue({ ok: true, context: sessionContext() });

    const route = withAuth(() => Response.json({ ok: true }), { allowApiKey: false });
    expect((await route(get(), noParams)).status).toBe(200);
  });
});

describe('CSRF', () => {
  it('refuses a cookie-authenticated mutation from another origin', async () => {
    resolveAuthContext.mockResolvedValue({ ok: true, context: sessionContext() });

    const response = await echo(post({ origin: 'https://evil.example' }), noParams);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('invalid_origin');
  });

  it('refuses a cookie-authenticated mutation with no Origin at all', async () => {
    resolveAuthContext.mockResolvedValue({ ok: true, context: sessionContext() });

    expect((await echo(post(), noParams)).status).toBe(403);
  });

  it('allows one from our own origin', async () => {
    resolveAuthContext.mockResolvedValue({ ok: true, context: sessionContext() });

    expect((await echo(post({ origin: APP_URL }), noParams)).status).toBe(200);
  });

  it('does not apply to reads', async () => {
    resolveAuthContext.mockResolvedValue({ ok: true, context: sessionContext() });

    expect((await echo(get({ origin: 'https://evil.example' }), noParams)).status).toBe(200);
  });

  it('does not apply to API keys, which are not ambient authority', async () => {
    resolveAuthContext.mockResolvedValue({ ok: true, context: apiKeyContext() });

    // A non-browser client sends no Origin and must still be able to write.
    expect((await echo(post(), noParams)).status).toBe(200);
  });
});

describe('the handler', () => {
  it('receives the resolved context', async () => {
    resolveAuthContext.mockResolvedValue({
      ok: true,
      context: sessionContext({ orgId: 'org_specific' }),
    });

    const body = await (await echo(get(), noParams)).json();
    expect(body).toEqual({ orgId: 'org_specific', kind: 'session' });
  });

  it('receives the route params', async () => {
    resolveAuthContext.mockResolvedValue({ ok: true, context: sessionContext() });

    const route = withAuth<{ id: string }>(async (_request, _auth, { params }) =>
      Response.json(await params),
    );
    const response = await route(get(), { params: Promise.resolve({ id: 'doc_1' }) });

    expect(await response.json()).toEqual({ id: 'doc_1' });
  });
});
