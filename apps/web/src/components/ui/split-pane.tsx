'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** Neither pane may be squeezed below this fraction of the container. */
const MIN_FRACTION = 0.25;
const MAX_FRACTION = 0.8;

/** Arrow keys move the divider by this much per press. */
const KEYBOARD_STEP = 0.02;

/**
 * A draggable vertical divider between two panes.
 *
 * A real `separator` with `aria-valuenow`, `aria-valuemin` and `aria-valuemax`,
 * moved by the arrow keys and reset by Home — so the split is adjustable
 * without a pointer, which a two-pane reading tool absolutely has to be.
 *
 * The handle is 1px of visible line inside an 11px hit area. A divider you can
 * see is a line; a divider you can grab is a target, and `design.md`'s
 * minimalism applies to what is drawn, not to what can be hit.
 */
export function SplitPane({
  left,
  right,
  fraction,
  onFraction,
  label,
  className,
  leftClassName,
  rightClassName,
}: {
  left: ReactNode;
  right: ReactNode;
  /** Width of the left pane, as a fraction of the container. */
  fraction: number;
  onFraction: (fraction: number) => void;
  label: string;
  className?: string;
  leftClassName?: string;
  rightClassName?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const clamp = useCallback(
    (value: number) => Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, value)),
    [],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      onFraction(clamp((event.clientX - box.left) / box.width));
    },
    [onFraction, clamp],
  );

  useEffect(() => {
    if (!dragging) return;

    function onUp() {
      setDragging(false);
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onUp);
    // While dragging, the cursor must not flicker between the two panes and a
    // drag must not start selecting the text under it.
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = previous;
      document.body.style.cursor = '';
    };
  }, [dragging, onPointerMove]);

  return (
    <div
      ref={containerRef}
      style={{ '--split-fraction': `${fraction * 100}%` } as React.CSSProperties}
      className={cn('flex min-h-0 w-full', className)}
    >
      <div
        className={cn(
          'min-w-0 min-[900px]:flex-none min-[900px]:w-[var(--split-fraction)]',
          leftClassName,
        )}
      >
        {left}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: there is no HTML element for a resize handle; `separator` with aria-valuenow is what WAI-ARIA prescribes, and the tabIndex below makes it focusable. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuemin={Math.round(MIN_FRACTION * 100)}
        aria-valuemax={Math.round(MAX_FRACTION * 100)}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => onFraction(0.58)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            onFraction(clamp(fraction - KEYBOARD_STEP));
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            onFraction(clamp(fraction + KEYBOARD_STEP));
          }
          if (event.key === 'Home') {
            event.preventDefault();
            onFraction(0.58);
          }
        }}
        className={cn(
          'group relative w-[11px] shrink-0 cursor-col-resize touch-none',
          'hidden min-[900px]:flex items-stretch justify-center',
        )}
      >
        <span aria-hidden className={cn('w-px', dragging ? 'bg-accent' : 'bg-border-subtle')} />
      </div>
      <div className={cn('min-w-0 min-[900px]:flex-1', rightClassName)}>{right}</div>
    </div>
  );
}
