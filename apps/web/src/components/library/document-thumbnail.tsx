'use client';

import { FileText } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * A document's first page, or the icon that stands in for it.
 *
 * `design.md` §5 wants a simple file-type icon rather than a large
 * illustration, and a thumbnail only where it genuinely helps recognition — so
 * this is small, quiet, and falls back to the icon without a layout shift.
 *
 * The image is a plain `<img>` pointed at `/api/documents/:id/thumbnail`, which
 * redirects to a presigned URL. `next/image` would proxy every page thumbnail
 * through the Next.js server and defeat the point, and these are already
 * optimised WebP written by the worker at a fixed size.
 */
export function DocumentThumbnail({
  documentId,
  filename,
  available,
  className,
}: {
  documentId: string;
  filename: string;
  available: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const show = available && !failed;

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)]',
        'border border-border-subtle bg-page',
        className,
      )}
    >
      {show ? (
        // biome-ignore lint/performance/noImgElement: see the note above — this is a redirect to storage, deliberately not proxied through the app.
        <img
          src={`/api/documents/${documentId}/thumbnail?page=1`}
          alt={`First page of ${filename}`}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover object-top"
          style={{ filter: 'var(--page-filter)' }}
        />
      ) : (
        <FileText aria-hidden className="size-4 text-foreground-subtle" />
      )}
    </span>
  );
}
