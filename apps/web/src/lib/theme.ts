/**
 * The three theme states, and the one place they are spelled.
 *
 * `system` is the default and stores nothing; `light` and `dark` are explicit
 * choices and stamp `data-theme` on the root element, which is what makes the
 * `:root[data-theme='dark']` block in `globals.css` win over the media query in
 * both directions.
 */
export const THEMES = ['system', 'light', 'dark'] as const;

export type Theme = (typeof THEMES)[number];

export const THEME_STORAGE_KEY = 'konusbitr.theme';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/**
 * The script that runs before first paint.
 *
 * Without it the page renders in sepia light and then flips to dark a frame
 * later, which is the single most noticeable defect a themed app can ship. It
 * is inlined into `<head>`, it touches only `documentElement`, and it swallows
 * its own errors because a browser with site data blocked must still render.
 *
 * Kept as a string rather than a module because it has to execute
 * synchronously, before React exists.
 */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}`;
