'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * A piece of per-viewer preference, remembered across visits.
 *
 * Every read and write is wrapped: a private window, cleared site data or a
 * browser configured to block storage makes the accessor itself throw, and a
 * pane divider is not worth a blank page. The initial render always uses the
 * fallback and the stored value arrives in an effect, because reading
 * `localStorage` during render is what produces a hydration mismatch.
 */
export function usePersistedState<T>(
  key: string,
  fallback: T,
  parse: (raw: string) => T | null,
  serialize: (value: T) => string,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(fallback);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `parse` is a caller-supplied function that is usually an inline closure. Depending on it would re-read storage on every render and clobber a value the reader just set; the key is the only thing that identifies what is being read.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return;
      const parsed = parse(raw);
      if (parsed !== null) setValue(parsed);
    } catch {
      // Unremembered is a fine state to be in.
    }
  }, [key]);

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, serialize(next));
      } catch {
        // Applies for this session even when it cannot be stored.
      }
    },
    [key, serialize],
  );

  return [value, update];
}

/** A number in `[min, max]`, remembered. Used for the workspace pane split. */
export function usePersistedNumber(
  key: string,
  fallback: number,
  bounds: { min: number; max: number },
): [number, (value: number) => void] {
  return usePersistedState<number>(
    key,
    fallback,
    (raw) => {
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed)) return null;
      return Math.min(bounds.max, Math.max(bounds.min, parsed));
    },
    (value) => String(value),
  );
}
