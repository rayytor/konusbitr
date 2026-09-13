import type { BoundingBox, Citation } from '@konusbitr/shared';

/**
 * A rectangle the viewer has been asked to draw.
 *
 * Distinct from `Citation` on purpose: the viewer knows nothing about chunks,
 * quotes or conversations, and everything it does know — an id, a page, a box —
 * is what a citation, a search hit or a future annotation all reduce to.
 */
export type HighlightTarget = {
  id: string;
  page: number;
  bbox: BoundingBox;
  /** Shown in the highlight's accessible announcement, when there is one. */
  label?: string;
};

/** The imperative surface the chat pane drives the viewer through. */
export type ViewerHandle = {
  /** Scroll a page to the top of the viewport. */
  goToPage: (page: number) => void;
  /**
   * Scroll to a citation, mark it, and flash it once.
   *
   * The mark persists until `clearHighlights` — `design.md` §7 asks for a
   * highlight that stays visible long enough to establish context, and in a
   * reading tool that means until the reader says otherwise, not 800ms.
   */
  showCitation: (citation: Citation, id: string) => void;
  /** Drop every mark. Bound to Escape in the workspace. */
  clearHighlights: () => void;
  /** Open the in-document search field. Bound to ⌘F / Ctrl+F. */
  openSearch: () => void;
  /** The page currently filling most of the viewport. */
  currentPage: () => number;
};

/** A citation the viewer can draw, with the id the chat pane refers to it by. */
export function citationToHighlight(citation: Citation, id: string): HighlightTarget {
  return {
    id,
    page: citation.page,
    bbox: citation.bbox,
    label: citation.quote,
  };
}
