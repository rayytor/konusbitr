'use client';

import type { ChatMessageView, Citation } from '@konusbitr/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The chat pane's connection to `POST /api/chat`.
 *
 * Phase 10's endpoint speaks a named-event SSE protocol of its own —
 * `status`, `text`, `citations`, `done`, `error` — rather than the Vercel AI
 * SDK's data-stream wire format, because the citations it emits are verified on
 * the server *after* the text has finished streaming and arrive as their own
 * frame. `useChat` cannot express that: it assumes the parts of a message
 * arrive interleaved with the text. So the transport is a `fetch` reader, and
 * the shape this hook returns is deliberately the shape `useChat` returns, so
 * the pane below it reads the same either way.
 *
 * Two properties are worth stating because they are the ones that break
 * quietly:
 *
 * - **`EventSource` cannot be used.** It only issues GETs, and the question is
 *   a body. A `fetch` reader also gives us a real `AbortController`, which is
 *   what the stop button needs.
 * - **Text is flushed on an animation frame, not per token.** A token arriving
 *   every few milliseconds, each one re-parsing the whole answer as markdown,
 *   is the difference between a smooth stream and a pane that drops frames for
 *   the length of the answer.
 */

export type ChatStatus = 'idle' | 'retrieving' | 'generating' | 'error';

export type UiMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  createdAt: string;
  /** Set while this message is the one being streamed. */
  streaming?: boolean;
};

export type UseChatStream = {
  messages: UiMessage[];
  status: ChatStatus;
  error: string | null;
  conversationId: string | null;
  send: (message: string) => void;
  stop: () => void;
  /** Re-ask the last question, replacing the answer it produced. */
  regenerate: () => void;
  /** Replace the last question with a new one and re-ask. */
  editLast: (message: string) => void;
  clearError: () => void;
};

type StreamTarget = { documentId: string } | { corpus: true };

function parseSseChunk(buffer: string): {
  events: { event: string; data: string }[];
  rest: string;
} {
  const events: { event: string; data: string }[] = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';

  for (const part of parts) {
    let event = 'message';
    const data: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') });
  }

  return { events, rest };
}

export function useChatStream({
  target,
  initialMessages,
  initialConversationId,
  onConversationCreated,
}: {
  target: StreamTarget;
  initialMessages: ChatMessageView[];
  initialConversationId?: string | null;
  onConversationCreated?: (conversationId: string) => void;
}): UseChatStream {
  const [messages, setMessages] = useState<UiMessage[]>(() =>
    initialMessages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        id: message.id,
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
        citations: (message.citations ?? []) as Citation[],
        createdAt: message.createdAt,
      })),
  );
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId ?? null,
  );

  const controller = useRef<AbortController | null>(null);
  const frame = useRef(0);
  const pending = useRef('');

  /**
   * The current transcript, readable outside of React's update cycle.
   *
   * `send` needs the messages to build the turn from, and reading them inside a
   * `setMessages` updater would fire the request twice under StrictMode —
   * updaters must be pure and React calls them twice in development precisely
   * to catch this.
   */
  const transcript = useRef(messages);
  transcript.current = messages;

  useEffect(() => {
    return () => {
      controller.current?.abort();
      cancelAnimationFrame(frame.current);
    };
  }, []);

  const flush = useCallback((assistantId: string) => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const text = pending.current;
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? { ...message, content: text } : message,
        ),
      );
    });
  }, []);

  const run = useCallback(
    async (question: string, history: UiMessage[]) => {
      const abort = new AbortController();
      controller.current = abort;
      setError(null);
      setStatus('retrieving');

      const userId = `local-user-${Date.now()}`;
      const assistantId = `local-assistant-${Date.now()}`;
      pending.current = '';

      setMessages([
        ...history,
        {
          id: userId,
          role: 'user',
          content: question,
          citations: [],
          createdAt: new Date().toISOString(),
        },
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          citations: [],
          createdAt: new Date().toISOString(),
          streaming: true,
        },
      ]);

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: abort.signal,
          body: JSON.stringify({
            message: question,
            ...(conversationId ? { conversationId } : target),
          }),
        });

        if (!response.ok || !response.body) {
          const problem = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(problem?.error?.message ?? 'The assistant could not be reached.');
        }

        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;

          const { events, rest } = parseSseChunk(buffer);
          buffer = rest;

          for (const frameIn of events) {
            const payload = JSON.parse(frameIn.data) as Record<string, unknown>;

            if (frameIn.event === 'status') {
              const next = payload.status;
              if (next === 'retrieving' || next === 'generating') setStatus(next);
              if (typeof payload.conversationId === 'string' && !conversationId) {
                setConversationId(payload.conversationId);
                onConversationCreated?.(payload.conversationId);
              }
            }

            if (frameIn.event === 'text' && typeof payload.text === 'string') {
              pending.current += payload.text;
              flush(assistantId);
            }

            if (frameIn.event === 'citations') {
              const citations = (payload.citations ?? []) as Citation[];
              setMessages((current) =>
                current.map((message) =>
                  message.id === assistantId ? { ...message, citations } : message,
                ),
              );
            }

            if (frameIn.event === 'error') {
              throw new Error(
                typeof payload.message === 'string'
                  ? payload.message
                  : 'The assistant stopped unexpectedly.',
              );
            }

            if (frameIn.event === 'done') {
              cancelAnimationFrame(frame.current);
              frame.current = 0;
              const finalText =
                typeof payload.cleanAnswer === 'string'
                  ? payload.cleanAnswer
                  : pending.current.replace(/<citations>[\s\S]*$/i, '').trim();
              setMessages((current) =>
                current.map((message) =>
                  message.id === assistantId
                    ? {
                        ...message,
                        // Adopt the server's id: it is what a later reload, an
                        // export or a permalink will refer to this turn by.
                        id: typeof payload.messageId === 'string' ? payload.messageId : message.id,
                        content: finalText,
                        streaming: false,
                      }
                    : message,
                ),
              );
            }
          }
        }

        setStatus('idle');
      } catch (failure) {
        cancelAnimationFrame(frame.current);
        frame.current = 0;

        if (abort.signal.aborted) {
          // A stopped answer is kept, not discarded: partial text with no
          // citations is still what the reader asked for, and throwing it away
          // makes the stop button feel like a mistake.
          const partial = pending.current;
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? { ...message, content: partial, streaming: false }
                : message,
            ),
          );
          setStatus('idle');
          return;
        }

        setMessages((current) => current.filter((message) => message.id !== assistantId));
        setError(failure instanceof Error ? failure.message : 'Something went wrong.');
        setStatus('error');
      } finally {
        controller.current = null;
      }
    },
    [conversationId, target, flush, onConversationCreated],
  );

  const send = useCallback(
    (message: string) => {
      const trimmed = message.trim();
      if (trimmed === '' || status === 'retrieving' || status === 'generating') return;
      void run(trimmed, transcript.current);
    },
    [run, status],
  );

  const stop = useCallback(() => controller.current?.abort(), []);

  /**
   * Ask the last question again.
   *
   * The replaced turn is dropped from the pane but stays in the conversation's
   * stored history, because the only way to remove it would be an endpoint that
   * deletes messages and Phase 10 does not have one. The visible transcript is
   * therefore the one the reader keeps; the stored one is a superset. Worth
   * revisiting when conversation editing becomes a product feature rather than
   * a convenience.
   */
  const regenerate = useCallback(() => {
    const current = transcript.current;
    const lastUser = [...current].reverse().find((message) => message.role === 'user');
    if (!lastUser) return;
    void run(lastUser.content, current.slice(0, current.indexOf(lastUser)));
  }, [run]);

  const editLast = useCallback(
    (message: string) => {
      const trimmed = message.trim();
      if (trimmed === '') return;
      const current = transcript.current;
      const lastUser = [...current].reverse().find((entry) => entry.role === 'user');
      const upTo = lastUser ? current.slice(0, current.indexOf(lastUser)) : current;
      void run(trimmed, upTo);
    },
    [run],
  );

  return {
    messages,
    status,
    error,
    conversationId,
    send,
    stop,
    regenerate,
    editLast,
    clearError: () => setError(null),
  };
}
