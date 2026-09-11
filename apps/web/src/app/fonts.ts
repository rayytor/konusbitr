import { Instrument_Serif } from 'next/font/google';
import localFont from 'next/font/local';

/**
 * The two families `design.md` §2 mandates: Instrument Serif for headings and
 * editorial display, LINE Seed JP for everything else.
 *
 * Both are served from our own origin — `next/font/google` self-hosts at build
 * time, and LINE Seed JP is vendored under `src/fonts` — so a Konusbitr
 * deployment makes no third-party requests to render a page.
 */

export const uiSans = localFont({
  src: [
    { path: '../fonts/line-seed-jp-regular.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/line-seed-jp-bold.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-line-seed-jp',
  fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
});

export const displaySerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  variable: '--font-instrument-serif',
  fallback: ['ui-serif', 'Georgia', 'serif'],
});
