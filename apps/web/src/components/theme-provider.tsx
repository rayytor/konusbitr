'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { isTheme, THEME_STORAGE_KEY, type Theme } from '@/lib/theme';

type ThemeContextValue = {
  /** What the user chose. `system` means "follow the OS". */
  theme: Theme;
  /** What is actually on screen right now, with `system` already resolved. */
  resolved: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Theme state for the whole app.
 *
 * The initial value is read from the DOM rather than from storage, because the
 * boot script in `<head>` has already put it there — reading it twice is how
 * the two disagree. Everything after that is a write to `data-theme` plus a
 * write to `localStorage`, wrapped because a browser with site data blocked
 * throws on the accessor itself rather than returning null.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('system');
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      // Private windows and blocked site data are ordinary, not exceptional.
    }
    if (isTheme(stored)) setThemeState(stored);

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(query.matches);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    const root = document.documentElement;
    if (next === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);

    try {
      if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // A theme that cannot be remembered still applies for this session.
    }
  }, []);

  const resolved: 'light' | 'dark' = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside a ThemeProvider');
  return value;
}

export { systemPrefersDark };
