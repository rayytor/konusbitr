import { scopedDb } from '@konusbitr/db';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';

type Params = { conversationId: string };

export const GET = withAuth<Params>(
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

    const url = new URL(request.url);
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

    const messages = await scoped.messagesForConversation(conversationId, {
      limit: Number.isFinite(limit) ? limit : undefined,
    });

    return Response.json(
      {
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

export const dynamic = 'force-dynamic';
