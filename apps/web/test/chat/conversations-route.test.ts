import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext, AuthResolution } from '@/lib/auth/context';

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

// Mock scopedDb and db
const mockConversations = [
  {
    id: 'cnv_1',
    orgId: 'org_1',
    userId: 'usr_1',
    scope: 'document',
    documentIds: ['doc_1'],
    title: 'Test Conversation',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
];

const mockMessages = [
  {
    id: 'msg_1',
    conversationId: 'cnv_1',
    role: 'user',
    content: 'Hello',
    citations: null,
    usage: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
];

vi.mock('@/lib/db', () => ({
  db: () => ({}),
}));

vi.mock('@konusbitr/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@konusbitr/db')>();
  return {
    ...actual,
    scopedDb: () => ({
      listConversations: vi.fn().mockResolvedValue(mockConversations),
      conversationById: vi.fn((id: string) => {
        const found = mockConversations.find((c) => c.id === id);
        return Promise.resolve(found);
      }),
      createConversation: vi.fn(
        (input: {
          userId: string;
          scope?: string;
          documentIds?: string[];
          title?: string | null;
        }) => {
          const created = {
            id: 'cnv_new',
            orgId: 'org_1',
            userId: input.userId,
            scope: input.scope ?? 'document',
            documentIds: input.documentIds ?? [],
            title: input.title ?? null,
            createdAt: new Date('2026-01-02T00:00:00Z'),
            updatedAt: new Date('2026-01-02T00:00:00Z'),
          };
          return Promise.resolve(created);
        },
      ),
      updateConversationTitle: vi.fn((id: string, title: string) => {
        const first = mockConversations[0] ?? {
          id: 'cnv_1',
          orgId: 'org_1',
          userId: 'usr_1',
          scope: 'document',
          documentIds: ['doc_1'],
          title: 'Test',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return Promise.resolve({ ...first, id, title, updatedAt: new Date() });
      }),

      deleteConversation: vi.fn(() => Promise.resolve([mockConversations[0]])),
      messagesForConversation: vi.fn(() => Promise.resolve(mockMessages)),
      documentById: vi.fn((id: string) =>
        Promise.resolve(id === 'doc_1' ? { id: 'doc_1', orgId: 'org_1' } : undefined),
      ),
    }),
  };
});

const { GET: listConversations, POST: createConversation } = await import(
  '@/app/api/conversations/route'
);
const {
  GET: getConversation,
  PATCH: updateConversation,
  DELETE: deleteConversation,
} = await import('@/app/api/conversations/[conversationId]/route');
const { GET: listMessages } = await import(
  '@/app/api/conversations/[conversationId]/messages/route'
);
const { POST: postChat } = await import('@/app/api/chat/route');

function userSession(): AuthContext {
  return {
    kind: 'session',
    userId: 'usr_1',
    orgId: 'org_1',
    role: 'member',
    scopes: ['chat', 'documents:read', 'documents:write'],
  };
}

const noParams = { params: Promise.resolve({}) };
function withParams<T>(params: T) {
  return { params: Promise.resolve(params) };
}

describe('Conversation API Routes', () => {
  beforeEach(() => {
    resolveAuthContext.mockResolvedValue({ ok: true, context: userSession() });
  });

  describe('GET /api/conversations', () => {
    it('returns a list of conversations', async () => {
      const req = new Request(`${APP_URL}/api/conversations`);
      const res = await listConversations(req, noParams);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.conversations).toHaveLength(1);
      expect(data.conversations[0].id).toBe('cnv_1');
    });
  });

  describe('POST /api/conversations', () => {
    it('creates a new document-scoped conversation', async () => {
      const req = new Request(`${APP_URL}/api/conversations`, {
        method: 'POST',
        headers: { origin: APP_URL, 'content-type': 'application/json' },
        body: JSON.stringify({ documentId: 'doc_1', title: 'My Chat' }),
      });
      const res = await createConversation(req, noParams);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.conversation.id).toBe('cnv_new');
      expect(data.conversation.title).toBe('My Chat');
    });

    it('rejects invalid JSON', async () => {
      const req = new Request(`${APP_URL}/api/conversations`, {
        method: 'POST',
        headers: { origin: APP_URL, 'content-type': 'application/json' },
        body: 'invalid-json',
      });
      const res = await createConversation(req, noParams);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/conversations/:id', () => {
    it('returns conversation details and messages', async () => {
      const req = new Request(`${APP_URL}/api/conversations/cnv_1`);
      const res = await getConversation(req, withParams({ conversationId: 'cnv_1' }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.conversation.id).toBe('cnv_1');
      expect(data.messages).toHaveLength(1);
    });

    it('returns 404 for nonexistent conversation', async () => {
      const req = new Request(`${APP_URL}/api/conversations/cnv_unknown`);
      const res = await getConversation(req, withParams({ conversationId: 'cnv_unknown' }));
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/conversations/:id', () => {
    it('updates conversation title', async () => {
      const req = new Request(`${APP_URL}/api/conversations/cnv_1`, {
        method: 'PATCH',
        headers: { origin: APP_URL, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed Chat' }),
      });
      const res = await updateConversation(req, withParams({ conversationId: 'cnv_1' }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.conversation.title).toBe('Renamed Chat');
    });

    it('rejects empty title', async () => {
      const req = new Request(`${APP_URL}/api/conversations/cnv_1`, {
        method: 'PATCH',
        headers: { origin: APP_URL, 'content-type': 'application/json' },
        body: JSON.stringify({ title: '' }),
      });
      const res = await updateConversation(req, withParams({ conversationId: 'cnv_1' }));
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/conversations/:id', () => {
    it('deletes conversation', async () => {
      const req = new Request(`${APP_URL}/api/conversations/cnv_1`, {
        method: 'DELETE',
        headers: { origin: APP_URL },
      });
      const res = await deleteConversation(req, withParams({ conversationId: 'cnv_1' }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.deleted).toBe(true);
    });
  });

  describe('GET /api/conversations/:id/messages', () => {
    it('lists messages for a conversation', async () => {
      const req = new Request(`${APP_URL}/api/conversations/cnv_1/messages`);
      const res = await listMessages(req, withParams({ conversationId: 'cnv_1' }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.messages).toHaveLength(1);
    });
  });

  describe('POST /api/chat validation', () => {
    it('rejects requests with missing message', async () => {
      const req = new Request(`${APP_URL}/api/chat`, {
        method: 'POST',
        headers: { origin: APP_URL, 'content-type': 'application/json' },
        body: JSON.stringify({ documentId: 'doc_1' }),
      });
      const res = await postChat(req, noParams);
      expect(res.status).toBe(400);
    });

    it('rejects requests with neither documentId, corpus, nor conversationId', async () => {
      const req = new Request(`${APP_URL}/api/chat`, {
        method: 'POST',
        headers: { origin: APP_URL, 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'What is this?' }),
      });
      const res = await postChat(req, noParams);
      expect(res.status).toBe(400);
    });
  });
});
