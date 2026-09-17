'use client';

import type { ChatMessageView, Citation, DocumentView } from '@konusbitr/shared';
import { Check, Copy, MessageSquare, Pencil, RefreshCw, Search, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Skeleton } from '@/components/ui/skeleton';
import { useChatStream } from '@/lib/use-chat-stream';
import { cn } from '@/lib/utils';
import { Answer } from './answer';
import { Composer } from './composer';

/**
 * The chat pane.
 *
 * Four states, all of them designed rather than left to fall out of the code:
 * a document that is still processing, an empty conversation, a streaming
 * answer, and a failure. `design.md` §17 and §23 are explicit that these are
 * part of the product — an empty state is a page the reader will see more often
 * than any other, and "Something went wrong!!!" is named in the specification as
 * the thing not to write.
 */

type ChatPaneProps = {
  document: DocumentView;
  initialMessages: ChatMessageView[];
  conversationId: string | null;
  onCitationSelect: (citation: Citation, id: string) => void;
  activeCitationId: string | null;
  composerRef?: React.RefObject<HTMLTextAreaElement | null>;
  onConversationCreated?: (conversationId: string) => void;
  live?: { stage: string; percent: number; message?: string } | undefined;
};

export function ChatPane({
  document: doc,
  initialMessages,
  conversationId,
  onCitationSelect,
  activeCitationId,
  composerRef,
  onConversationCreated,
  live,
}: ChatPaneProps) {
  const target = useMemo(() => ({ documentId: doc.id }), [doc.id]);
  const chat = useChatStream({
    target,
    initialMessages,
    initialConversationId: conversationId,
    ...(onConversationCreated ? { onConversationCreated } : {}),
  });

  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // `partially_ready` answers. That is the whole of partial readiness on this
  // side: a chunk exists only because the page it came from was read, so an
  // answer over a partially indexed document is grounded in pages that have
  // genuinely been parsed and its citations verify against real page text
  // exactly as they would at the end. The viewer's banner says which pages are
  // covered; the composer does not need to refuse.
  const ready = doc.status === 'ready' || doc.status === 'partially_ready';
  const failed = doc.status === 'failed' || doc.status === 'cancelled';
  const busy = chat.status === 'retrieving' || chat.status === 'generating';

  // Starter questions, once, and only for a document that can answer them.
  useEffect(() => {
    if (!ready || chat.messages.length > 0) return;
    let cancelled = false;

    fetch(`/api/documents/${doc.id}/suggestions`)
      .then((response) => (response.ok ? response.json() : { suggestions: [] }))
      .then((payload: { suggestions?: string[] }) => {
        if (!cancelled) setSuggestions(payload.suggestions ?? []);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });

    return () => {
      cancelled = true;
    };
  }, [doc.id, ready, chat.messages.length]);

  /**
   * Follow the stream, unless the reader has scrolled away from it.
   *
   * Auto-scrolling a reader who has gone back to check an earlier answer is one
   * of the most irritating things a chat UI can do, so the pane only sticks to
   * the bottom while it is already there.
   */
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    function onScroll() {
      if (!node) return;
      pinnedToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    }

    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the transcript is precisely what this effect watches — it re-pins to the bottom when a message arrives, not when anything inside the effect body changes.
  useEffect(() => {
    if (!pinnedToBottom.current) return;
    const node = scrollRef.current;
    node?.scrollTo({ top: node.scrollHeight });
  }, [chat.messages]);

  const copy = useCallback((id: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(id);
      setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600);
    });
  }, []);

  const lastAssistantId = [...chat.messages].reverse().find((m) => m.role === 'assistant')?.id;

  return (
    <section aria-label="Chat" className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        {!ready ? (
          <ProcessingState document={doc} failed={failed} live={live} />
        ) : chat.messages.length === 0 ? (
          <EmptyState
            filename={doc.filename}
            suggestions={suggestions}
            onPick={(question) => chat.send(question)}
          />
        ) : (
          <ol className="mx-auto flex w-full max-w-2xl flex-col gap-7">
            {chat.messages.map((message) =>
              message.role === 'user' ? (
                <li key={message.id} className="flex flex-col items-end gap-1">
                  {editing === message.id ? (
                    <EditQuestion
                      initial={message.content}
                      onCancel={() => setEditing(null)}
                      onSubmit={(next) => {
                        setEditing(null);
                        chat.editLast(next);
                      }}
                    />
                  ) : (
                    <>
                      <p
                        className={cn(
                          'max-w-[85%] rounded-[var(--radius-md)] bg-surface-muted px-3.5 py-2.5',
                          'text-[15px] leading-relaxed whitespace-pre-wrap',
                        )}
                      >
                        {message.content}
                      </p>
                      {!busy && message.id === lastUserId(chat.messages) ? (
                        <IconButton
                          variant="tertiary"
                          icon={Pencil}
                          label="Edit this question"
                          side="left"
                          onClick={() => setEditing(message.id)}
                        />
                      ) : null}
                    </>
                  )}
                </li>
              ) : (
                <li key={message.id} className="flex flex-col gap-2">
                  {/*
                    The answer is a live region so that a screen-reader user
                    hears it arrive rather than discovering it later. `polite`
                    and not `assertive`: it should not interrupt.
                  */}
                  <div aria-live={message.streaming ? 'polite' : 'off'} aria-atomic="false">
                    <Answer
                      content={message.content}
                      citations={message.citations}
                      activeCitationId={activeCitationId}
                      onSelectCitation={onCitationSelect}
                      streaming={message.streaming ?? false}
                    />
                  </div>

                  {message.streaming ? null : (
                    <div className="flex items-center gap-0.5">
                      <IconButton
                        variant="tertiary"
                        icon={copied === message.id ? Check : Copy}
                        label={copied === message.id ? 'Copied' : 'Copy answer'}
                        onClick={() => copy(message.id, message.content)}
                      />
                      {message.id === lastAssistantId ? (
                        <IconButton
                          variant="tertiary"
                          icon={RefreshCw}
                          label="Ask again"
                          onClick={chat.regenerate}
                        />
                      ) : null}
                      {message.citations.length > 0 ? (
                        <span className="ml-1.5 text-[13px] text-foreground-subtle">
                          {message.citations.length}{' '}
                          {message.citations.length === 1 ? 'citation' : 'citations'}
                        </span>
                      ) : null}
                    </div>
                  )}
                </li>
              ),
            )}

            {chat.status === 'retrieving' ? <StageIndicator stage="retrieving" /> : null}
          </ol>
        )}

        {chat.error ? (
          <div className="mx-auto mt-6 w-full max-w-2xl">
            <Alert tone="error">{chat.error}</Alert>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => {
                chat.clearError();
                chat.regenerate();
              }}
            >
              Try again
            </Button>
          </div>
        ) : null}
      </div>

      <div className="border-t border-border-subtle px-5 py-3">
        <div className="mx-auto w-full max-w-2xl">
          <Composer
            onSend={chat.send}
            onStop={chat.stop}
            busy={busy}
            disabled={!ready}
            placeholder={ready ? 'Ask about this document' : 'Available once the document is ready'}
            {...(composerRef ? { inputRef: composerRef } : {})}
          />
          <p className="mt-2 text-[13px] text-foreground-subtle">
            Every claim is cited, and every citation is checked against the page it names.
          </p>
        </div>
      </div>
    </section>
  );
}

function lastUserId(messages: readonly { id: string; role: string }[]): string | undefined {
  return [...messages].reverse().find((message) => message.role === 'user')?.id;
}

/**
 * What the assistant is doing right now.
 *
 * Retrieval happens before a single token exists, and it is the part of a
 * grounded answer that takes the longest. Saying so is the difference between
 * a pause that reads as work and one that reads as a hang.
 */
function StageIndicator({ stage }: { stage: 'retrieving' }) {
  return (
    <li className="flex flex-col gap-2" aria-live="polite">
      <p className="flex items-center gap-2 text-[13px] text-foreground-muted">
        <Search aria-hidden className="size-3.5" />
        {stage === 'retrieving' ? 'Searching the document…' : null}
      </p>
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="h-3 w-3/5" />
    </li>
  );
}

function EmptyState({
  filename,
  suggestions,
  onPick,
}: {
  filename: string;
  suggestions: string[] | null;
  onPick: (question: string) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-5 pt-6">
      <MessageSquare aria-hidden className="size-5 text-foreground-subtle" />
      <div>
        <h2 className="font-serif text-[24px] leading-tight">Ask this document anything</h2>
        <p className="mt-2 max-w-prose text-[15px] leading-relaxed text-foreground-muted">
          Answers come only from {filename}, and each one carries the page it came from. Click a
          page reference to see the exact passage highlighted.
        </p>
      </div>

      {suggestions === null ? (
        <div className="flex w-full max-w-lg flex-col gap-2">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      ) : suggestions.length > 0 ? (
        <div className="flex w-full flex-col gap-2">
          <p className="flex items-center gap-1.5 text-[13px] text-foreground-subtle">
            <Sparkles aria-hidden className="size-3.5" />
            Suggested questions
          </p>
          <ul className="flex flex-col items-start gap-1.5">
            {suggestions.map((question) => (
              <li key={question}>
                <button
                  type="button"
                  onClick={() => onPick(question)}
                  className={cn(
                    'cursor-pointer rounded-[var(--radius-sm)] border border-border-subtle',
                    'bg-surface px-3 py-2 text-left text-[15px] text-foreground hover:bg-surface-muted',
                  )}
                >
                  {question}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ProcessingState({
  document: doc,
  failed,
  live,
}: {
  document: DocumentView;
  failed: boolean;
  live?: { stage: string; percent: number; message?: string } | undefined;
}) {
  if (failed) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-4 pt-6">
        <h2 className="font-serif text-[24px] leading-tight">
          We couldn&apos;t read this document
        </h2>
        <Alert tone="error">{doc.error ?? 'The document could not be processed.'}</Alert>
        <p className="text-[15px] leading-relaxed text-foreground-muted">
          {doc.errorCode === 'needs_ocr'
            ? 'This looks like a scan with no text layer. Konusbitr refuses to guess at a page it cannot read, because an answer built on an empty document is confidently wrong.'
            : 'Nothing was indexed, so there is nothing to answer from.'}
        </p>
        <Button asChild variant="secondary" size="sm">
          <a href="/documents">Back to the library</a>
        </Button>
      </div>
    );
  }

  const percent = live?.percent;
  const stage = live?.stage ?? 'queued';

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-4 pt-6">
      <h2 className="font-serif text-[24px] leading-tight">Still reading this document</h2>
      <p className="max-w-prose text-[15px] leading-relaxed text-foreground-muted">
        Konusbitr is parsing the pages and indexing the passages. The chat opens as soon as there is
        something to answer from — you can watch the progress below and in the header.
      </p>
      <div className="flex w-full max-w-md flex-col gap-2 pt-2">
        <div className="flex items-center justify-between text-[13px] text-foreground-muted">
          <span className="capitalize">{stage}</span>
          <span className="tabular-nums font-medium text-foreground">
            {percent !== undefined && percent > 0 ? `${Math.round(percent)}%` : 'In queue'}
          </span>
        </div>
        <progress
          max={100}
          value={percent !== undefined && percent > 0 ? percent : undefined}
          aria-label={`Processing progress: ${percent !== undefined ? Math.round(percent) : 0}%`}
          className="h-2 w-full overflow-hidden rounded-full bg-surface-muted [&::-webkit-progress-bar]:bg-surface-muted [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent"
        />
        {live?.message ? (
          <p className="text-[13px] text-foreground-subtle">{live.message}</p>
        ) : null}
      </div>
    </div>
  );
}

function EditQuestion({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);

  return (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
      }}
    >
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the field replaces the message the reader just clicked "edit" on; anywhere else for the caret is wrong.
        autoFocus
        value={value}
        aria-label="Edit your question"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmit(value);
          }
        }}
        rows={2}
        className={cn(
          'w-full resize-none rounded-[var(--radius-md)] border border-accent bg-surface px-3 py-2',
          'text-[15px] leading-relaxed focus-visible:outline-none',
        )}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="tertiary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          Ask again
        </Button>
      </div>
    </form>
  );
}
