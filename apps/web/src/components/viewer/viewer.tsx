'use client';

import type { Citation } from '@konusbitr/shared';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import {
  clampScale,
  fitScale,
  MAX_SCALE,
  MIN_SCALE,
  type PageGeometry,
  type Rotation,
  renderedPageSize,
} from './geometry';
import { PageBadge } from './page-badge';
import { PageView } from './page-view';
import { describePdfError, openPdf } from './pdf';
import { type SearchMatch, searchDocument } from './search';
import { ViewerToolbar } from './toolbar';
import { citationToHighlight, type HighlightTarget, type ViewerHandle } from './types';

/**
 * Gap between pages, and the padding around the column, in CSS pixels.
 *
 * Wide enough to hold a page's OCR badge, which sits in the gutter above the
 * paper rather than on it — a marker drawn over the page would cover the one
 * thing a reader opened the page to check.
 */
const PAGE_GAP = 26;
const COLUMN_PADDING = 24;

/**
 * How many pages either side of the viewport are kept rendered.
 *
 * One. Two would smooth a fast flick slightly and doubles the number of live
 * canvases; at 500 pages the memory, not the raster time, is what decides
 * whether scrolling stays smooth.
 */
const OVERSCAN = 1;

/** Fallback geometry for a document whose pages have not been parsed yet. */
const US_LETTER = { width: 612, height: 792 } as const;

export type ViewerProps = {
  /** A presigned URL the browser fetches the PDF from, by byte range. */
  url: string;
  /** Page sizes from the `pages` table, in the one coordinate convention. */
  pages: readonly PageGeometry[];
  filename: string;
  downloadUrl?: string | undefined;
  handleRef?: Ref<ViewerHandle>;
  /** Announced when a citation is focused, for the workspace's live region. */
  onCitationFocus?: (highlight: HighlightTarget) => void;
  className?: string;
};

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; pdf: PDFDocumentProxy }
  | { kind: 'error'; message: string };

/**
 * The PDF viewer.
 *
 * Continuous vertical scroll with a rendered window of pages, zoom and fit
 * modes, rotation, find-in-document, and the one thing the whole product is
 * built around: `showCitation`, which scrolls a bounding box into view and
 * lights it up on the page.
 *
 * Page geometry comes from the database rather than from PDF.js, and that is
 * load-bearing rather than incidental. Knowing every page's size before a
 * single one has been fetched means the scroll container has its true height on
 * the first frame — so the scrollbar does not grow under the reader's thumb,
 * and a jump to page 400 lands on page 400 instead of somewhere that will be
 * page 400 once the pages above it have loaded.
 */
export function Viewer({
  url,
  pages,
  filename,
  downloadUrl,
  handleRef,
  onCitationFocus,
  className,
}: ViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(1);
  const [fitMode, setFitMode] = useState<'width' | 'page' | null>('width');
  const [rotation, setRotation] = useState<Rotation>(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);

  const [citations, setCitations] = useState<HighlightTarget[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number } | null>(null);

  // ── Loading ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const controller = new AbortController();
    setStatus({ kind: 'loading' });
    setLoadProgress(null);

    openPdf(url, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (!controller.signal.aborted) setLoadProgress(progress);
      },
    })
      .then((pdf) => {
        if (!controller.signal.aborted) setStatus({ kind: 'ready', pdf });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setStatus({ kind: 'error', message: describePdfError(error) });
      });

    return () => controller.abort();
  }, [url]);

  const pdf = status.kind === 'ready' ? status.pdf : null;

  // ── Geometry and layout ────────────────────────────────────────────────────

  const pageCount = pdf?.numPages ?? pages.length ?? 0;

  const geometries = useMemo<PageGeometry[]>(() => {
    const byPage = new Map(pages.map((page) => [page.page, page]));
    // Missing rows fall back to the previous page's size and then to Letter,
    // which is what a document still being parsed looks like: the first pages
    // have rows and the tail does not.
    //
    // The *size* is inherited and the tier is not. A guessed size is a good
    // guess — consecutive pages of a document are nearly always the same shape,
    // and the point of the guess is a scroll container whose height does not
    // change under the reader's thumb. A guessed tier would be a claim about
    // how a page was read, made about a page nothing has read yet, and it would
    // put an "OCR 71%" badge on a blank placeholder.
    let last: { width: number; height: number } = pages[0] ?? US_LETTER;
    return Array.from({ length: pageCount }, (_unused, index) => {
      const found = byPage.get(index + 1);
      if (found) last = { width: found.width, height: found.height };
      return found
        ? { ...found, page: index + 1 }
        : { page: index + 1, width: last.width, height: last.height };
    });
  }, [pages, pageCount]);

  const layout = useMemo(() => {
    const offsets: number[] = [];
    let top = COLUMN_PADDING;
    let widest = 0;

    for (const geometry of geometries) {
      const size = renderedPageSize(geometry, scale, rotation);
      offsets.push(top);
      top += size.height + PAGE_GAP;
      widest = Math.max(widest, size.width);
    }

    return { offsets, totalHeight: top - PAGE_GAP + COLUMN_PADDING, widest };
  }, [geometries, scale, rotation]);

  const columnWidth = Math.max(layout.widest, viewport.width - COLUMN_PADDING * 2);

  // ── Viewport measurement ───────────────────────────────────────────────────

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setViewport({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Fit modes are sticky: a reader who chose "fit width" expects it to survive
  // the pane being dragged wider, which means recomputing rather than freezing
  // the scale that fitting produced once.
  useEffect(() => {
    if (!fitMode || viewport.width === 0) return;
    const first = geometries[0];
    if (!first) return;
    setScale(
      fitScale(
        first,
        {
          width: viewport.width - COLUMN_PADDING * 2,
          height: viewport.height - COLUMN_PADDING * 2,
        },
        fitMode,
        rotation,
      ),
    );
  }, [fitMode, viewport, geometries, rotation]);

  // ── Scrolling ──────────────────────────────────────────────────────────────

  const scrollTo = useCallback((top: number, smooth: boolean) => {
    scrollRef.current?.scrollTo({
      top: Math.max(0, top),
      behavior:
        smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'smooth'
          : 'auto',
    });
  }, []);

  const goToPage = useCallback(
    (page: number) => {
      const index = Math.min(Math.max(page, 1), Math.max(pageCount, 1)) - 1;
      const offset = layout.offsets[index];
      if (offset === undefined) return;
      scrollTo(offset - COLUMN_PADDING, true);
    },
    [layout.offsets, pageCount, scrollTo],
  );

  /**
   * Put a rectangle a third of the way down the viewport.
   *
   * Not centred, and not at the top. A citation at the very top has no context
   * above it — the reader cannot see the sentence it follows from — and one in
   * the exact middle pushes the paragraph it belongs to off the bottom on a
   * short pane. A third down shows the lead-in and the consequence together.
   */
  const scrollToRect = useCallback(
    (pageIndex: number, topPoints: number, smooth: boolean) => {
      const offset = layout.offsets[pageIndex];
      if (offset === undefined) return;
      const target = offset + topPoints * scale - viewport.height / 3;
      scrollTo(target, smooth);
    },
    [layout.offsets, scale, viewport.height, scrollTo],
  );

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    let frame = 0;
    function onScroll() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const top = node?.scrollTop ?? 0;
        setScrollTop(top);

        // "The page you are reading" is the one under the first third of the
        // viewport, not the first one intersecting it: at fit-width a sliver of
        // the previous page is nearly always still on screen.
        const probe = top + (node?.clientHeight ?? 0) / 3;
        let page = 1;
        for (const [index, offset] of layout.offsets.entries()) {
          if (offset <= probe) page = index + 1;
          else break;
        }
        setCurrentPage(page);
      });
    }

    node.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      node.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [layout.offsets]);

  // ── Zoom ───────────────────────────────────────────────────────────────────

  /**
   * Change the scale while keeping the point under the cursor still.
   *
   * Without this, zooming in on page 300 throws the reader back to roughly page
   * 30, because the same `scrollTop` means something entirely different once
   * every page above has grown.
   */
  const zoomAround = useCallback(
    (next: number, anchorY?: number) => {
      const node = scrollRef.current;
      const clamped = clampScale(next);
      if (!node) {
        setScale(clamped);
        return;
      }

      const anchor = anchorY ?? node.clientHeight / 2;
      const documentY = (node.scrollTop + anchor - COLUMN_PADDING) / scale;

      setFitMode(null);
      setScale(clamped);

      requestAnimationFrame(() => {
        node.scrollTop = documentY * clamped + COLUMN_PADDING - anchor;
      });
    },
    [scale],
  );

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    function onWheel(event: WheelEvent) {
      // Ctrl/⌘ + wheel is the platform zoom gesture, and a trackpad pinch
      // arrives as exactly this event. Both belong to the document, not to the
      // browser's page zoom, so the default is prevented.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = node?.getBoundingClientRect();
      zoomAround(scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientY - (rect?.top ?? 0));
    }

    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [scale, zoomAround]);

  // ── Search ─────────────────────────────────────────────────────────────────

  // `currentPage` only decides which page the scan starts from, so a scroll
  // during a search restarts it from where the reader now is — which is what
  // they would want, and cheap because every page's index is cached.
  useEffect(() => {
    if (!pdf || !searchOpen || query.trim().length < 2) {
      setMatches([]);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    setSearching(true);
    setMatchIndex(0);

    const timer = setTimeout(() => {
      void searchDocument(pdf, query, {
        startPage: currentPage,
        signal: controller.signal,
        onProgress: ({ matches: found, done }) => {
          if (controller.signal.aborted) return;
          setMatches(found);
          if (done) setSearching(false);
        },
      }).catch(() => setSearching(false));
    }, 200);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pdf, searchOpen, query, currentPage]);

  const goToMatch = useCallback(
    (index: number) => {
      const match = matches[index];
      if (!match) return;
      setMatchIndex(index);
      scrollToRect(match.page - 1, match.bbox[1], true);
    },
    [matches, scrollToRect],
  );

  // ── The imperative handle ──────────────────────────────────────────────────

  const showCitation = useCallback(
    (citation: Citation, id: string) => {
      const highlight = citationToHighlight(citation, id);
      setCitations((current) => [
        ...current.filter((entry) => entry.id !== highlight.id),
        highlight,
      ]);
      setActiveId(highlight.id);
      scrollToRect(citation.page - 1, citation.bbox[1], true);
      onCitationFocus?.(highlight);
    },
    [scrollToRect, onCitationFocus],
  );

  useImperativeHandle(
    handleRef,
    () => ({
      goToPage,
      showCitation,
      clearHighlights: () => {
        setCitations([]);
        setActiveId(null);
        setSearchOpen(false);
      },
      openSearch: () => setSearchOpen(true),
      currentPage: () => currentPage,
    }),
    [goToPage, showCitation, currentPage],
  );

  // ── The rendered window ────────────────────────────────────────────────────

  const window_ = useMemo(() => {
    if (pageCount === 0) return { first: 0, last: -1 };
    const top = scrollTop;
    const bottom = scrollTop + viewport.height;

    let first = 0;
    let last = pageCount - 1;

    for (const [index, offset] of layout.offsets.entries()) {
      const size = renderedPageSize(
        geometries[index] ?? { page: index + 1, ...US_LETTER },
        scale,
        rotation,
      );
      if (offset + size.height < top) first = index + 1;
      if (offset > bottom) {
        last = index - 1;
        break;
      }
    }

    return {
      first: Math.max(0, first - OVERSCAN),
      last: Math.min(pageCount - 1, Math.max(first, last) + OVERSCAN),
    };
  }, [scrollTop, viewport.height, layout.offsets, geometries, scale, rotation, pageCount]);

  const highlightsByPage = useMemo(() => {
    const all: HighlightTarget[] = [
      ...citations,
      ...matches.map((match) => ({ id: match.id, page: match.page, bbox: match.bbox })),
    ];
    const grouped = new Map<number, HighlightTarget[]>();
    for (const highlight of all) {
      const list = grouped.get(highlight.page);
      if (list) list.push(highlight);
      else grouped.set(highlight.page, [highlight]);
    }
    return grouped;
  }, [citations, matches]);

  const activeHighlightId = matches[matchIndex]?.id ?? activeId;

  // ── Render ─────────────────────────────────────────────────────────────────

  if (status.kind === 'error') {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-4 p-10', className)}>
        <h2 className="font-serif text-[24px]">We couldn&apos;t display this document</h2>
        <Alert tone="error">{status.message}</Alert>
      </div>
    );
  }

  const rendered: number[] = [];
  for (let index = window_.first; index <= window_.last; index += 1) rendered.push(index);

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <ViewerToolbar
        page={currentPage}
        pageCount={pageCount}
        scale={scale}
        fitMode={fitMode}
        rotation={rotation}
        filename={filename}
        downloadUrl={downloadUrl}
        searchOpen={searchOpen}
        query={query}
        matchCount={matches.length}
        matchIndex={matchIndex}
        searching={searching}
        hasHighlights={citations.length > 0}
        onGoToPage={goToPage}
        onZoom={(next) => zoomAround(next)}
        onFit={(mode) => setFitMode(mode)}
        onRotate={() => setRotation((current) => ((current + 90) % 360) as Rotation)}
        onToggleSearch={(open) => {
          setSearchOpen(open);
          if (!open) setQuery('');
        }}
        onQuery={setQuery}
        onStepMatch={(delta) => {
          if (matches.length === 0) return;
          goToMatch((matchIndex + delta + matches.length) % matches.length);
        }}
        onClearHighlights={() => {
          setCitations([]);
          setActiveId(null);
        }}
      />

      {/* biome-ignore lint/a11y/useSemanticElements: `region` with a name is exactly what this is — a labelled landmark holding the pages — and no element carries that meaning. */}
      <div
        ref={scrollRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container has to be focusable to be scrolled from the keyboard, which a paged reading surface must be.
        tabIndex={0}
        role="region"
        aria-label={`${filename}, ${pageCount} pages`}
        className="relative min-h-0 flex-1 overflow-auto bg-surface-sunken focus-visible:outline-none"
      >
        {status.kind === 'loading' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-[15px] text-foreground-subtle">Opening document…</p>
            {loadProgress && loadProgress.total > 0 ? (
              <div className="flex items-center gap-2.5">
                <progress
                  max={loadProgress.total}
                  value={loadProgress.loaded}
                  aria-label={`Opening ${filename}`}
                  className="h-1.5 w-44 overflow-hidden rounded-full bg-surface-muted [&::-webkit-progress-bar]:bg-surface-muted [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent"
                />
                <span className="text-xs tabular-nums text-foreground-subtle">
                  {Math.round((loadProgress.loaded / loadProgress.total) * 100)}%
                </span>
              </div>
            ) : (
              <progress
                max={100}
                aria-label={`Opening ${filename}`}
                className="h-1.5 w-44 overflow-hidden rounded-full bg-surface-muted [&::-webkit-progress-bar]:bg-surface-muted [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent"
              />
            )}
          </div>
        ) : null}

        {pdf ? (
          <div
            className="relative mx-auto"
            style={{ height: `${layout.totalHeight}px`, width: `${columnWidth}px` }}
          >
            {rendered.map((index) => {
              const geometry = geometries[index];
              const offset = layout.offsets[index];
              if (!geometry || offset === undefined) return null;
              const size = renderedPageSize(geometry, scale, rotation);

              return (
                <div
                  key={geometry.page}
                  className="absolute"
                  style={{
                    top: `${offset}px`,
                    left: `${Math.max(0, (columnWidth - size.width) / 2)}px`,
                  }}
                >
                  <PageBadge
                    page={geometry}
                    className="absolute right-0 bottom-full mb-1.5 bg-surface"
                  />
                  <PageView
                    pdf={pdf}
                    pageNumber={geometry.page}
                    geometry={geometry}
                    scale={scale}
                    rotation={rotation}
                    highlights={highlightsByPage.get(geometry.page) ?? []}
                    activeHighlightId={activeHighlightId}
                  />
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <p aria-live="polite" className="sr-only">
        {`Page ${currentPage} of ${pageCount}`}
      </p>
    </div>
  );
}

export { MAX_SCALE, MIN_SCALE };
