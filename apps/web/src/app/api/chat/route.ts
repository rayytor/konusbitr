import { ChatRequestSchema } from '@konusbitr/shared';
import { withAuth } from '@/lib/auth/with-auth';
import { handleChatStream } from '@/lib/chat/service';

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

    const parsed = ChatRequestSchema.safeParse(body);
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

    return handleChatStream(request, auth, parsed.data);
  },
  { scopes: ['chat'] },
);

export const dynamic = 'force-dynamic';
