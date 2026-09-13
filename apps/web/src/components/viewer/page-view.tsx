'use client';

import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { memo, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { bboxToRect, type PageGeometry, type Rotation, renderedPageSize } from './geometry';
import { loadPdfjs } from './pdf';
import type { HighlightTarget } from './types';

/**
 * How much of a page can be rasterised at once.
 *
 * A canvas is allocated at `scale × devicePixelRatio`, and browsers refuse to
 * allocate one past roughly 2^25 pixels — on a Retina display at 400% zoom an
 * A3 page crosses that line and the page renders blank with no error. Capping
 * the backing store and letting CSS stretch it trades a little sharpness at
 * extreme zoom for a page that is always visible.
 */
const MAX_CANVAS_PIXELS = 16_000_000;

type PageViewProps = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  geometry: PageGeometry;
  scale: number;
  rotation: Rotation;
  highlights: readonly HighlightTarget[];
  activeHighlightId: string | null;
  onHighlightClick?: (highlight: HighlightTarget) => void;
  /** Set once the page's text has been laid out, for in-document search. */
  onTextReady?: (pageNumber: number, container: HTMLElement) => void;
};

/**
 * One page: a canvas, a transparent text layer, and the highlights.
 *
 * Three layers in a fixed order, and the order is the product. The canvas is
 * the paper. The highlight rectangles sit *above* the canvas but *below* the
 * text, composited with `multiply`, so a cited sentence reads as ink on amber
 * rather than as a translucent box laid over the words — `design.md` §7 asks
 * for a highlight that "feels integrated with the paper", and stacking order is
 * the whole of how that is achieved. The text layer is on top, transparent,
 * selectable, and found by the browser's own Ctrl+F.
 *
 * Memoised on its props because a scroll through a 500-page document
 * re-renders the window constantly and re-rasterising an unchanged page is
 * exactly the jank this phase's acceptance criteria forbid.
 */
function PageViewImpl({
  pdf,
  pageNumber,
  geometry,
  scale,
  rotation,
  highlights,
  activeHighlightId,
  onHighlightClick,
  onTextReady,
}: PageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);

  const size = renderedPageSize(geometry, scale, rotation);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    let page: PDFPageProxy | undefined;

    async function draw() {
      const pdfjs = await loadPdfjs();
      page = await pdf.getPage(pageNumber);
      if (cancelled) return;

      // PDF.js's default rotation is the page's own `/Rotate`, which is what
      // puts the page into the same "visible" frame the worker normalised
      // bounding boxes into. The viewer's rotation control is added on top.
      const viewport = page.getViewport({ scale, rotation: page.rotate + rotation });

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const wanted = viewport.width * viewport.height * dpr * dpr;
      const output =
        wanted > MAX_CANVAS_PIXELS
          ? Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height))
          : dpr;

      const canvas = canvasRef.current;
      if (!canvas) return;

      canvas.width = Math.floor(viewport.width * output);
      canvas.height = Math.floor(viewport.height * output);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return;

      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: output === 1 ? undefined : [output, 0, 0, output, 0, 0],
      });

      try {
        await renderTask.promise;
      } catch (error) {
        // A cancelled render is the normal outcome of scrolling past a page or
        // changing zoom mid-raster, and is not worth a console entry.
        if ((error as Error)?.name !== 'RenderingCancelledException') throw error;
        return;
      }
      if (cancelled) return;
      setRendered(true);

      const container = textRef.current;
      if (!container) return;
      container.replaceChildren();

      const textLayer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true }),
        container,
        viewport,
      });
      await textLayer.render();
      if (cancelled) {
        textLayer.cancel();
        return;
      }
      onTextReady?.(pageNumber, container);
    }

    void draw().catch(() => {
      // A single page that will not rasterise must not take the document down;
      // the placeholder stays and the rest of the document is still readable.
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      // `page.cleanup()` releases the page's operator list and font data. On a
      // 500-page document, not calling it is the difference between a steady
      // ~200MB and an unbounded climb until the tab is killed.
      page?.cleanup();
    };
  }, [pdf, pageNumber, scale, rotation, onTextReady]);

  return (
    <div
      data-page-number={pageNumber}
      className="kb-page relative shrink-0 bg-page shadow-[var(--page-shadow)]"
      style={
        {
          width: `${size.width}px`,
          height: `${size.height}px`,
          '--scale-factor': scale,
        } as React.CSSProperties
      }
    >
      {/* Dimmed, never inverted: an inverted scan is unreadable and an inverted
          photograph misrepresents the document. See `--page-filter`. */}
      <canvas
        ref={canvasRef}
        aria-label={`Page ${pageNumber}`}
        className="absolute inset-0 block"
        style={{ filter: 'var(--page-filter)' }}
      />

      {!rendered ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-serif text-[15px] text-foreground-subtle">{pageNumber}</span>
        </div>
      ) : null}

      {/* Below the text, above the canvas, multiplied into the paper. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-[2]">
        {highlights.map((highlight) => {
          const rect = bboxToRect(highlight.bbox, geometry, scale, rotation);
          const active = highlight.id === activeHighlightId;
          return (
            <button
              key={highlight.id}
              type="button"
              tabIndex={-1}
              onClick={() => onHighlightClick?.(highlight)}
              data-citation-id={highlight.id}
              data-active={active ? 'true' : undefined}
              className={cn(
                'pointer-events-auto absolute cursor-pointer rounded-[3px] mix-blend-multiply',
                active ? 'kb-citation-flash bg-highlight-active' : 'bg-highlight',
              )}
              style={{
                left: `${rect.left}px`,
                top: `${rect.top}px`,
                width: `${rect.width}px`,
                height: `${rect.height}px`,
              }}
            />
          );
        })}
      </div>

      <div
        ref={textRef}
        className="kb-text-layer"
        onPointerDown={(event) => event.currentTarget.classList.add('kb-selecting')}
        onPointerUp={(event) => event.currentTarget.classList.remove('kb-selecting')}
      />
    </div>
  );
}

export const PageView = memo(PageViewImpl);
