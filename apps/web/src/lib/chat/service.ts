import {
  buildContext,
  loadPrompt,
  streamChat,
  verifyCitations,
  windowHistory,
} from '@konusbitr/ai';
import { scopedDb } from '@konusbitr/db';
import { retrieve } from '@konusbitr/retrieval';
import type { ChatRequest } from '@konusbitr/shared';
import type { AuthContext } from '@/lib/auth/context';
import { db } from '@/lib/db';
import { loadWebEnv } from '@/lib/env';
import { autoTitleConversation } from './title';

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Handle grounded chat stream with verified citations and guaranteed message persistence.
 */
export async function handleChatStream(
  request: Request,
  auth: AuthContext,
  input: ChatRequest,
): Promise<Response> {
  const scoped = scopedDb(db(), auth.orgId);
  const env = loadWebEnv();

  // 1. Resolve or create conversation
  let isNewConversation = false;
  let conv: Awaited<ReturnType<typeof scoped.createConversation>>;

  if (input.conversationId) {
    const existing = await scoped.conversationById(input.conversationId);
    if (!existing) {
      return Response.json(
        { error: { code: 'not_found', message: 'Conversation not found in this organization.' } },
        { status: 404 },
      );
    }
    conv = existing;
  } else {
    isNewConversation = true;
    const isCorpus = input.corpus === true;
    let documentIds: string[] = [];

    if (!isCorpus) {
      if (!input.documentId) {
        return Response.json(
          {
            error: { code: 'invalid_request', message: 'documentId or corpus: true is required.' },
          },
          { status: 400 },
        );
      }
      const doc = await scoped.documentById(input.documentId);
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

    conv = await scoped.createConversation({
      userId,
      scope: isCorpus ? 'corpus' : 'document',
      documentIds,
    });
  }

  // 2. Persist user message immediately so a dropped connection never loses the turn
  const userMsg = await scoped.createMessage({
    conversationId: conv.id,
    role: 'user',
    content: input.message,
  });

  // 3. Create Server-Sent Events stream
  const responseStream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(sseEvent(event, data)));
        } catch {
          // Client disconnected
        }
      };

      try {
        // Send initial "retrieving" event immediately — keeps TTFT under 1.5s
        send('status', {
          status: 'retrieving',
          conversationId: conv.id,
          userMessageId: userMsg.id,
        });

        // 4. Fetch conversation history for query rewriting
        const allMessages = await scoped.messagesForConversation(conv.id);
        const priorTurns = allMessages
          .filter((m) => m.id !== userMsg.id)
          .map((m) => ({
            role: m.role as 'user' | 'assistant' | 'system',
            content: m.content,
          }));

        // 5. Execute hybrid retrieval
        const firstDocId = conv.documentIds[0] ?? '';
        const scope =
          conv.scope === 'corpus'
            ? ({ kind: 'corpus' } as const)
            : ({ kind: 'document', documentId: firstDocId } as const);

        const chunks = await retrieve({
          db: db(),
          orgId: auth.orgId,
          scope,
          query: input.message,
          history: priorTurns,
          env,
        });

        send('status', {
          status: 'generating',
          chunksCount: chunks.length,
        });

        // 6. Build prompt & context
        const contextStr = buildContext(chunks);
        const systemPrompt = loadPrompt('chat.answer.v1');

        const { windowed: windowedHistory } = windowHistory(priorTurns, 3000);
        const promptMessages = [
          ...windowedHistory,
          {
            role: 'user' as const,
            content: `DOCUMENT CONTEXT:\n${contextStr}\n\nQUESTION: ${input.message}`,
          },
        ];

        // 7. Stream text through LiteLLM/OpenAI-compatible router
        const streamResult = streamChat({
          env,
          system: systemPrompt,
          messages: promptMessages,
          temperature: 0.1,
          abortSignal: request.signal,
        });

        let fullRawText = '';

        for await (const delta of streamResult.textStream) {
          fullRawText += delta;
          send('text', { text: delta });
        }

        // 8. Citation post-processing and mechanical verification
        const { verified, rejected, cleanAnswer } = verifyCitations(fullRawText, chunks);

        if (rejected.length > 0) {
          console.warn(
            `[chat] rejected ${rejected.length} unverifiable citation(s) for conversation ${conv.id}:`,
            rejected,
          );
        }

        send('citations', {
          citations: verified,
          rejected,
        });

        // 9. Persist assistant message on completion
        const usageData = await streamResult.usage.catch(() => null);
        const assistantMsg = await scoped.createMessage({
          conversationId: conv.id,
          role: 'assistant',
          content: cleanAnswer,
          citations: verified as unknown as Record<string, unknown>[],
          usage: usageData as Record<string, unknown> | null,
        });

        // 10. Auto-title conversation if needed
        if (isNewConversation && !conv.title) {
          void autoTitleConversation(conv.id, input.message, cleanAnswer, auth.orgId);
        }

        // 11. Signal stream completion
        send('done', {
          conversationId: conv.id,
          messageId: assistantMsg.id,
          citationsCount: verified.length,
        });
      } catch (streamError) {
        const message = streamError instanceof Error ? streamError.message : String(streamError);
        console.error(`[chat] streaming error in conversation ${conv.id}:`, streamError);
        send('error', { message });
      } finally {
        try {
          controller.close();
        } catch {
          // Stream already closed
        }
      }
    },
  });

  return new Response(responseStream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
