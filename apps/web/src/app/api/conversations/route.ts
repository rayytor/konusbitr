import { scopedDb } from '@konusbitr/db';
import { CreateConversationRequestSchema } from '@konusbitr/shared';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { updatedAt: Date; id: string } | null {
  try {
    const [timestamp, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    const updatedAt = new Date(timestamp ?? '');
    if (!id || Number.isNaN(updatedAt.getTime())) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

export const GET = withAuth(
  async (request, auth) => {
    const url = new URL(request.url);
    const scoped = scopedDb(db(), auth.orgId);

    const requested = Number(url.searchParams.get('limit') ?? DEFAULT_PAGE_SIZE);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

    const cursorStr = url.searchParams.get('cursor');
    const documentId = url.searchParams.get('documentId');

    const before = cursorStr ? decodeCursor(cursorStr) : null;
    if (cursorStr && !before) {
      return Response.json(
        { error: { code: 'invalid_cursor', message: 'That page cursor is not valid.' } },
        { status: 400 },
      );
    }

    const rows = await scoped.listConversations({
      limit: limit + 1,
      before: before ?? undefined,
      documentId: documentId ?? undefined,
    });

    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return Response.json(
      {
        conversations: page.map((row) => ({
          id: row.id,
          orgId: row.orgId,
          userId: row.userId,
          scope: row.scope,
          documentIds: row.documentIds,
          title: row.title,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
        nextCursor: rows.length > limit && last ? encodeCursor(last.updatedAt, last.id) : null,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  },
  { scopes: ['chat'] },
);

export const POST = withAuth(
  async (request, auth) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: { code: 'invalid_json', message: 'Request body must be valid JSON.' } },
        { status: 400 },
      );
    }

    const parsed = CreateConversationRequestSchema.safeParse(body ?? {});
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

    const scoped = scopedDb(db(), auth.orgId);
    const isCorpus = parsed.data.corpus === true;
    let documentIds: string[] = [];

    if (!isCorpus && parsed.data.documentId) {
      const doc = await scoped.documentById(parsed.data.documentId);
      if (!doc) {
        return Response.json(
          { error: { code: 'not_found', message: 'Document not found in this organization.' } },
          { status: 404 },
        );
      }
      documentIds = [doc.id];
    }

    let userId = auth.userId;
    if (!userId) {
      const members = await scoped.members();
      userId = members[0]?.userId;
    }
    if (!userId) {
      return Response.json(
        { error: { code: 'user_required', message: 'No valid user found for this organization.' } },
        { status: 400 },
      );
    }

    const row = await scoped.createConversation({
      userId,
      scope: isCorpus ? 'corpus' : 'document',
      documentIds,
      title: parsed.data.title ?? null,
    });

    return Response.json(
      {
        conversation: {
          id: row.id,
          orgId: row.orgId,
          userId: row.userId,
          scope: row.scope,
          documentIds: row.documentIds,
          title: row.title,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      },
      { status: 201, headers: { 'cache-control': 'no-store' } },
    );
  },
  { scopes: ['chat'] },
);

export const dynamic = 'force-dynamic';
