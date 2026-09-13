'use client';

import type { Citation } from '@konusbitr/shared';
import { memo, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { CitationChip } from './citation-chip';
import { rehypeCitationMarks } from './citation-marks';

/**
 * An assistant answer, rendered.
 *
 * `design.md` §8 asks for readability over containers: paragraph spacing,
 * headings, lists and tables where they help, and no border around every
 * response. So there is no card here — the answer is typeset, not boxed.
 *
 * A citation marker whose citation did not survive verification renders as
 * nothing at all. That is the correct behaviour and it is worth being explicit
 * about: the server already dropped the claim's citation because the quote
 * could not be found in the document, and showing a chip that leads nowhere
 * would reintroduce exactly the unverifiable reference the whole pipeline
 * exists to prevent.
 */
export const Answer = memo(function Answer({
  content,
  citations,
  activeCitationId,
  onSelectCitation,
  streaming = false,
}: {
  content: string;
  citations: readonly Citation[];
  activeCitationId: string | null;
  onSelectCitation: (citation: Citation, id: string) => void;
  streaming?: boolean;
}) {
  const byKey = useMemo(() => {
    const map = new Map<string, Citation>();
    for (const citation of citations) map.set(`${citation.chunkId}:${citation.page}`, citation);
    return map;
  }, [citations]);

  const cleanContent = useMemo(() => {
    return content.replace(/<citations>[\s\S]*$/i, '').trim();
  }, [content]);

  return (
    <div
      className={cn(
        'text-[15px] leading-[1.7] text-foreground',
        '[&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
        '[&_h1]:mt-6 [&_h1]:mb-2 [&_h1]:font-serif [&_h1]:text-[24px] [&_h1]:leading-tight',
        '[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:font-serif [&_h2]:text-[18px] [&_h2]:leading-tight',
        '[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:font-serif [&_h3]:text-[15px] [&_h3]:leading-tight',
        '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_li]:my-1 [&_li]:pl-1',
        '[&_a]:text-accent-contrast [&_a]:underline [&_a]:underline-offset-2',
        '[&_strong]:font-bold',
        '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-foreground-muted',
        '[&_hr]:my-5 [&_hr]:border-border-subtle',
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeCitationMarks]}
        components={{
          span(props) {
            const chunkId = (props as { 'data-citation-chunk'?: string })['data-citation-chunk'];
            const page = (props as { 'data-citation-page'?: string })['data-citation-page'];
            if (!chunkId || !page) return <span {...props} />;

            const citation = byKey.get(`${chunkId}:${page}`);
            // Unverified, or not yet arrived while the answer is still
            // streaming. Either way there is nothing honest to show.
            if (!citation) return null;

            const id = `${chunkId}:${page}`;
            return (
              <CitationChip
                citation={citation}
                active={activeCitationId === id}
                onSelect={() => onSelectCitation(citation, id)}
              />
            );
          },
          // Wide content scrolls inside itself rather than widening the pane —
          // a chat column that grows a horizontal scrollbar because one table
          // is wide makes the whole conversation harder to read.
          table(props) {
            return (
              <div className="my-4 overflow-x-auto rounded-[var(--radius-sm)] border border-border-subtle">
                <table className="w-full border-collapse text-[15px]" {...props} />
              </div>
            );
          },
          th(props) {
            return (
              <th
                className="border-b border-border-subtle bg-surface-muted px-3 py-2 text-left font-normal text-foreground-muted"
                {...props}
              />
            );
          },
          td(props) {
            return <td className="border-b border-border-subtle px-3 py-2 align-top" {...props} />;
          },
          pre(props) {
            return (
              <pre
                className="my-4 overflow-x-auto rounded-[var(--radius-md)] border border-border-subtle bg-surface-muted p-3 text-[13px] leading-relaxed"
                {...props}
              />
            );
          },
          code(props) {
            const { children, className, ...rest } = props;
            const fenced = typeof className === 'string' && className.includes('language-');
            return fenced ? (
              <code className={className} {...rest}>
                {children}
              </code>
            ) : (
              <code
                className="rounded-[4px] bg-surface-muted px-1 py-px font-mono text-[13px]"
                {...rest}
              >
                {children}
              </code>
            );
          },
        }}
      >
        {cleanContent}
      </Markdown>

      {streaming ? (
        <span
          aria-hidden
          className="kb-caret ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-foreground-muted"
        />
      ) : null}
    </div>
  );
});
