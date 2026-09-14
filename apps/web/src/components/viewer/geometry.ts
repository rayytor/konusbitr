import type { BoundingBox } from '@konusbitr/shared';

/**
 * Turning a citation into a rectangle.
 *
 * `docs/coordinates.md` is the contract this file consumes: a bbox arrives in
 * PDF points, origin top-left, y down, on the **visible** (already un-rotated)
 * page whose size is the `width`/`height` on the `pages` row. The viewer's
 * entire job is therefore a scale multiply — and the rotation branch below is
 * not a second coordinate system creeping in, it is the *user's* rotation
 * control, which is applied on top of a page that is already in the one
 * convention.
 *
 * If a rectangle ever lands in the wrong place with `rotation: 0`, the bug is
 * in `services/worker/src/konusbitr_worker/parse/geometry.py`. Do not
 * compensate here; that is how a rendering layer silently becomes an
 * undocumented second convention.
 */

/** How a page's text was obtained. Mirrors `pages.tier`. */
export type PageTier = 'native' | 'ocr' | 'vlm';

/** A page's size in PDF points, as the reader sees it. */
export type PageGeometry = {
  page: number;
  /** Visible width in points. */
  width: number;
  /** Visible height in points. */
  height: number;
  /**
   * How this page's text was obtained. Absent on a document parsed before the
   * OCR tier existed, which is a born-digital document by construction.
   */
  tier?: PageTier;
  /**
   * `0`-`1` for a recognised page; `null` for a born-digital one, where nothing
   * guessed and so there is nothing to be confident about.
   */
  ocrConfidence?: number | null;
};

/** A rectangle in CSS pixels, relative to the rendered page's top-left. */
export type PageRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** The four rotations a viewer control can apply, in degrees clockwise. */
export type Rotation = 0 | 90 | 180 | 270;

/** Normalize any integer degree value into `{0, 90, 180, 270}`. */
export function normalizeRotation(degrees: number): Rotation {
  const wrapped = (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;
  return wrapped as Rotation;
}

/**
 * The size, in CSS pixels, that a page occupies at a given scale and rotation.
 *
 * Used for layout *before* PDF.js has resolved the page, which is what lets the
 * scroll container have its true height from the first frame — a 500-page
 * document whose scrollbar grows as pages load is unusable, because every
 * scroll lands somewhere other than where it was aimed.
 */
export function renderedPageSize(
  geometry: PageGeometry,
  scale: number,
  rotation: Rotation,
): { width: number; height: number } {
  const swap = rotation === 90 || rotation === 270;
  return {
    width: (swap ? geometry.height : geometry.width) * scale,
    height: (swap ? geometry.width : geometry.height) * scale,
  };
}

/**
 * A bounding box as a rectangle over the rendered page.
 *
 * With `rotation: 0` this is `bbox * scale` and nothing else, exactly as
 * `docs/coordinates.md` promises. The other three cases apply the same mapping
 * the worker's rotation table uses, so a reader who rotates the page keeps a
 * highlight on the words it belongs to.
 */
export function bboxToRect(
  bbox: BoundingBox,
  geometry: PageGeometry,
  scale: number,
  rotation: Rotation = 0,
): PageRect {
  const [rawX0, rawY0, rawX1, rawY1] = bbox;
  const x0 = Math.min(rawX0, rawX1);
  const x1 = Math.max(rawX0, rawX1);
  const y0 = Math.min(rawY0, rawY1);
  const y1 = Math.max(rawY0, rawY1);

  const { width: w, height: h } = geometry;
  const boxWidth = x1 - x0;
  const boxHeight = y1 - y0;

  const rect =
    rotation === 90
      ? { left: h - y1, top: x0, width: boxHeight, height: boxWidth }
      : rotation === 180
        ? { left: w - x1, top: h - y1, width: boxWidth, height: boxHeight }
        : rotation === 270
          ? { left: y0, top: w - x1, width: boxHeight, height: boxWidth }
          : { left: x0, top: y0, width: boxWidth, height: boxHeight };

  return {
    left: rect.left * scale,
    top: rect.top * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/**
 * The scale that makes a page fill the available width, or fit inside the
 * available box entirely.
 *
 * Clamped, because "fit width" on a 3000-point fold-out page at a 320px
 * viewport produces a scale at which PDF.js renders nothing legible, and a
 * reader is better served by a page they can pan than by a grey smear.
 */
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 6;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function fitScale(
  geometry: PageGeometry,
  available: { width: number; height: number },
  mode: 'width' | 'page',
  rotation: Rotation = 0,
): number {
  const swap = rotation === 90 || rotation === 270;
  const pageWidth = swap ? geometry.height : geometry.width;
  const pageHeight = swap ? geometry.width : geometry.height;

  const byWidth = available.width / pageWidth;
  if (mode === 'width') return clampScale(byWidth);
  return clampScale(Math.min(byWidth, available.height / pageHeight));
}
