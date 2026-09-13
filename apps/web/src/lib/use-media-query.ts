'use client';

import { useEffect, useState } from 'react';

/**
 * Whether a media query matches, right now.
 *
 * Always `false` on the first render, including on the server: the workspace
 * uses this to choose between a split pane and tabs, and guessing wrong during
 * hydration produces a layout that visibly reflows on load. Starting from the
 * mobile layout and widening in an effect is the direction that reflows least,
 * and matches `design.md` §21's instruction to simplify for small screens
 * rather than cram the desktop layout into them.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const list = window.matchMedia(query);
    setMatches(list.matches);

    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
