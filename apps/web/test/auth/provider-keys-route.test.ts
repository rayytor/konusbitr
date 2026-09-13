import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext, AuthResolution } from '@/lib/auth/context';

const APP_URL = 'http://localhost:3000';
const AUTH_SECRET = 'konusbitr-test-auth-secret-32-chars-long';

const resolveAuthContext = vi.fn<(request: Request) => Promise<AuthResolution>>();

vi.mock('@/lib/auth/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/context')>()),
  resolveAuthContext: (request: Request) => resolveAuthContext(request),
}));

vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env')>()),
  loadWebEnv: () => ({ APP_URL, NODE_ENV: 'test', AUTH_SECRET }),
}));

let mockOrgSettings: Record<string, unknown> = {};

vi.mock('@konusbitr/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@konusbitr/db')>()),
  scopedDb: () => ({
    organization: async () => ({
      id: 'org_1',
      name: 'Test Org',
      slug: 'test-org',
      settings: mockOrgSettings,
    }),
    updateOrganizationSettings: async (settings: Record<string, unknown>) => {
      mockOrgSettings = settings;
      return { id: 'org_1', settings };
    },
  }),
}));

const { GET, POST } = await import('@/app/api/provider-keys/route');
const { DELETE } = await import('@/app/api/provider-keys/[keyId]/route');

function adminContext(): AuthContext {
  return {
    kind: 'session',
    userId: 'usr_1',
    orgId: 'org_1',
    role: 'admin',
    scopes: ['documents:read', 'documents:write'],
  };
}

const noParams = { params: Promise.resolve({}) };

describe('Provider Keys API routes', () => {
  beforeEach(() => {
    mockOrgSettings = {};
    resolveAuthContext.mockReset();
    resolveAuthContext.mockResolvedValue({ ok: true, context: adminContext() });
  });

  it('GET /api/provider-keys returns empty list initially', async () => {
    const request = new Request(`${APP_URL}/api/provider-keys`, {
      headers: { origin: APP_URL },
    });

    const response = await GET(request, noParams);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { keys: unknown[] };
    expect(body.keys).toEqual([]);
  });

  it('POST /api/provider-keys saves a new provider key', async () => {
    const request = new Request(`${APP_URL}/api/provider-keys`, {
      method: 'POST',
      headers: {
        origin: APP_URL,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'openai',
        key: 'sk-proj-test12345678901234567890',
        label: 'OpenAI Test',
      }),
    });

    const response = await POST(request, noParams);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      key: { provider: string; label: string; maskedKey: string };
    };
    expect(body.key.provider).toBe('openai');
    expect(body.key.label).toBe('OpenAI Test');
    expect(body.key.maskedKey).toContain('••••');

    // Verify GET now returns the key
    const getReq = new Request(`${APP_URL}/api/provider-keys`, {
      headers: { origin: APP_URL },
    });
    const getRes = await GET(getReq, noParams);
    const getBody = (await getRes.json()) as { keys: Array<{ provider: string }> };
    expect(getBody.keys).toHaveLength(1);
    expect(getBody.keys[0]?.provider).toBe('openai');
  });

  it('DELETE /api/provider-keys/[keyId] removes a provider key', async () => {
    // First create a key
    const createReq = new Request(`${APP_URL}/api/provider-keys`, {
      method: 'POST',
      headers: {
        origin: APP_URL,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'anthropic',
        key: 'sk-ant-test1234567890',
        label: 'Claude Test',
      }),
    });
    const createRes = await POST(createReq, noParams);
    const created = (await createRes.json()) as { key: { id: string } };

    // Delete it
    const deleteReq = new Request(`${APP_URL}/api/provider-keys/${created.key.id}`, {
      method: 'DELETE',
      headers: { origin: APP_URL },
    });
    const deleteRes = await DELETE(deleteReq, {
      params: Promise.resolve({ keyId: created.key.id }),
    });
    expect(deleteRes.status).toBe(204);

    // Verify GET is empty
    const getReq = new Request(`${APP_URL}/api/provider-keys`, {
      headers: { origin: APP_URL },
    });
    const getRes = await GET(getReq, noParams);
    const getBody = (await getRes.json()) as { keys: unknown[] };
    expect(getBody.keys).toHaveLength(0);
  });

  it('DELETE /api/provider-keys/[keyId] returns 404 for non-existent key', async () => {
    const deleteReq = new Request(`${APP_URL}/api/provider-keys/nonexistent`, {
      method: 'DELETE',
      headers: { origin: APP_URL },
    });
    const deleteRes = await DELETE(deleteReq, {
      params: Promise.resolve({ keyId: 'nonexistent' }),
    });
    expect(deleteRes.status).toBe(404);
  });
});
