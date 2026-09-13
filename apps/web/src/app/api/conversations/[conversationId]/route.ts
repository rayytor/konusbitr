import { scopedDb } from '@konusbitr/db';
import { UpdateConversationRequestSchema } from '@konusbitr/shared';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';

type Params = { conversationId: string };

export const GET = withAuth<Params>(
  async (_request, auth, { params }) => {
    const { conversationId } = await params;
    const scoped = scopedDb(db(), auth.orgId);

    const conv = await scoped.conversationById(conversationId);
    if (!conv) {
      return Response.json(
        { error: { code: 'not_found', message: 'Conversation not found in this organization.' } },
        { status: 404 },
      );
    }

    const messages = await scoped.messagesForConversation(conversationId);

    return Response.json(
      {
        conversation: {
          id: conv.id,
          orgId: conv.orgId,
          userId: conv.userId,
          scope: conv.scope,
          documentIds: conv.documentIds,
          title: conv.title,
          createdAt: conv.createdAt.toISOString(),
          updatedAt: conv.updatedAt.toISOString(),
        },
        messages: messages.map((m) => ({
          id: m.id,
          conversationId: m.conversationId,
          role: m.role,
          content: m.content,
          citations: m.citations,
          usage: m.usage,
          createdAt: m.createdAt.toISOString(),
        })),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  },
  { scopes: ['chat'] },
);

export const PATCH = withAuth<Params>(
  async (request, auth, { params }) => {
    const { conversationId } = await params;
    const scoped = scopedDb(db(), auth.orgId);

    const conv = await scoped.conversationById(conversationId);
    if (!conv) {
      return Response.json(
        { error: { code: 'not_found', message: 'Conversation not found in this organization.' } },
        { status: 404 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: { code: 'invalid_json', message: 'Request body must be valid JSON.' } },
        { status: 400 },
      );
    }

    const parsed = UpdateConversationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          error: {
            code: 'invalid_request',
            message: parsed.error.issues.map((i) => i.message).join(', '),
          },
        },
        { status: 400 },
      );
    }

    const updated = await scoped.updateConversationTitle(conversationId, parsed.data.title);

    return Response.json(
      {
        conversation: {
          id: updated.id,
          orgId: updated.orgId,
          userId: updated.userId,
          scope: updated.scope,
          documentIds: updated.documentIds,
          title: updated.title,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        },
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  },
  { scopes: ['chat'] },
);

export const DELETE = withAuth<Params>(
  async (_request, auth, { params }) => {
    const { conversationId } = await params;
    const scoped = scopedDb(db(), auth.orgId);

    const conv = await scoped.conversationById(conversationId);
    if (!conv) {
      return Response.json(
        { error: { code: 'not_found', message: 'Conversation not found in this organization.' } },
        { status: 404 },
      );
    }

    await scoped.deleteConversation(conversationId);

    return Response.json(
      { deleted: true, id: conversationId },
      { headers: { 'cache-control': 'no-store' } },
    );
  },
  { scopes: ['chat'] },
);

export const dynamic = 'force-dynamic';
