'use client';

import {
  ChevronDown,
  ChevronUp,
  Download,
  Eraser,
  Maximize2,
  Minus,
  Plus,
  RotateCw,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Rotation } from './geometry';

/**
 * The viewer's controls.
 *
 * `design.md` §7 asks for controls that are discoverable and unobtrusive, and
 * icons wherever an icon is unambiguous — so this is one thin bar of
 * monoline icons, each with a tooltip and an accessible name, and exactly two
 * pieces of text: the page number, which is also the page input, and the zoom
 * percentage. Nothing here animates on hover.
 */
export function ViewerToolbar({
  page,
  pageCount,
  scale,
  fitMode,
  rotation,
  filename,
  downloadUrl,
  searchOpen,
  query,
  matchCount,
  matchIndex,
  searching,
  hasHighlights,
  onGoToPage,
  onZoom,
  onFit,
  onRotate,
  onToggleSearch,
  onQuery,
  onStepMatch,
  onClearHighlights,
}: {
  page: number;
  pageCount: number;
  scale: number;
  fitMode: 'width' | 'page' | null;
  rotation: Rotation;
  filename: string;
  downloadUrl?: string | undefined;
  searchOpen: boolean;
  query: string;
  matchCount: number;
  matchIndex: number;
  searching: boolean;
  hasHighlights: boolean;
  onGoToPage: (page: number) => void;
  onZoom: (scale: number) => void;
  onFit: (mode: 'width' | 'page') => void;
  onRotate: () => void;
  onToggleSearch: (open: boolean) => void;
  onQuery: (value: string) => void;
  onStepMatch: (delta: 1 | -1) => void;
  onClearHighlights: () => void;
}) {
  const [draft, setDraft] = useState(String(page));
  const searchInput = useRef<HTMLInputElement>(null);

  // The field follows the scroll position unless it is being typed into.
  useEffect(() => {
    if (document.activeElement?.getAttribute('data-page-input') !== 'true') {
      setDraft(String(page));
    }
  }, [page]);

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  function commitPage() {
    const parsed = Number.parseInt(draft, 10);
    if (Number.isInteger(parsed)) onGoToPage(parsed);
    else setDraft(String(page));
  }

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border-subtle bg-surface px-2 py-1.5">
      <div className="flex items-center gap-0.5">
        <IconButton
          variant="tertiary"
          icon={ChevronUp}
          label="Previous page"
          disabled={page <= 1}
          onClick={() => onGoToPage(page - 1)}
        />
        <IconButton
          variant="tertiary"
          icon={ChevronDown}
          label="Next page"
          disabled={page >= pageCount}
          onClick={() => onGoToPage(page + 1)}
        />
      </div>

      <div className="flex items-center gap-1.5 px-1 text-[13px] text-foreground-muted">
        <input
          data-page-input="true"
          aria-label="Page number"
          inputMode="numeric"
          value={draft}
          onChange={(event) => setDraft(event.target.value.replace(/\D/g, ''))}
          onBlur={commitPage}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitPage();
              event.currentTarget.blur();
            }
          }}
          className={cn(
            'h-7 w-11 rounded-[var(--radius-sm)] border border-border-subtle bg-background',
            'px-1.5 text-center text-[13px] tabular-nums text-foreground',
            'focus-visible:border-accent focus-visible:outline-none',
          )}
        />
        <span className="tabular-nums">of {pageCount || '—'}</span>
      </div>

      <span aria-hidden className="mx-1 h-5 w-px bg-border-subtle" />

      <div className="flex items-center gap-0.5">
        <IconButton
          variant="tertiary"
          icon={Minus}
          label="Zoom out"
          onClick={() => onZoom(scale / 1.2)}
        />
        <span className="w-12 text-center text-[13px] tabular-nums text-foreground-muted">
          {Math.round(scale * 100)}%
        </span>
        <IconButton
          variant="tertiary"
          icon={Plus}
          label="Zoom in"
          onClick={() => onZoom(scale * 1.2)}
        />
      </div>

      <div className="flex items-center gap-0.5">
        <Tooltip label="Fit to width">
          <button
            type="button"
            onClick={() => onFit('width')}
            aria-pressed={fitMode === 'width'}
            className={cn(
              'h-9 cursor-pointer rounded-[var(--radius-sm)] px-2 text-[15px]',
              fitMode === 'width'
                ? 'bg-surface-muted text-foreground'
                : 'text-foreground-muted hover:text-foreground',
            )}
          >
            Width
          </button>
        </Tooltip>
        <IconButton
          variant="tertiary"
          icon={Maximize2}
          label="Fit whole page"
          active={fitMode === 'page'}
          onClick={() => onFit('page')}
        />
        <IconButton
          variant="tertiary"
          icon={RotateCw}
          label={`Rotate (currently ${rotation}°)`}
          active={rotation !== 0}
          onClick={onRotate}
        />
      </div>

      <span aria-hidden className="mx-1 h-5 w-px bg-border-subtle" />

      {searchOpen ? (
        <div className="flex flex-1 items-center gap-1">
          <Search aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
          <input
            ref={searchInput}
            type="search"
            aria-label={`Find in ${filename}`}
            placeholder="Find in document"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onStepMatch(event.shiftKey ? -1 : 1);
              }
              if (event.key === 'Escape') onToggleSearch(false);
            }}
            className="h-7 min-w-0 flex-1 border-none bg-transparent text-[15px] focus-visible:outline-none"
          />
          <span
            aria-live="polite"
            className="shrink-0 whitespace-nowrap text-[13px] tabular-nums text-foreground-subtle"
          >
            {query.trim().length < 2
              ? ''
              : matchCount === 0
                ? searching
                  ? 'Searching…'
                  : 'No matches'
                : `${matchIndex + 1} of ${matchCount}${searching ? '+' : ''}`}
          </span>
          <IconButton
            variant="tertiary"
            icon={ChevronUp}
            label="Previous match"
            disabled={matchCount === 0}
            onClick={() => onStepMatch(-1)}
          />
          <IconButton
            variant="tertiary"
            icon={ChevronDown}
            label="Next match"
            disabled={matchCount === 0}
            onClick={() => onStepMatch(1)}
          />
          <IconButton
            variant="tertiary"
            icon={X}
            label="Close search"
            onClick={() => onToggleSearch(false)}
          />
        </div>
      ) : (
        <div className="ml-auto flex items-center gap-0.5">
          {hasHighlights ? (
            <IconButton
              variant="tertiary"
              icon={Eraser}
              label="Clear citation highlights"
              onClick={onClearHighlights}
            />
          ) : null}
          <IconButton
            variant="tertiary"
            icon={Search}
            label="Find in document"
            onClick={() => onToggleSearch(true)}
          />
          {downloadUrl ? (
            <Tooltip label="Download">
              <a
                href={downloadUrl}
                aria-label={`Download ${filename}`}
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-foreground-muted hover:text-foreground"
              >
                <Download aria-hidden className="size-4" />
              </a>
            </Tooltip>
          ) : null}
        </div>
      )}
    </div>
  );
}
