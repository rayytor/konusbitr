import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@/components/theme-provider';
import { ToastProvider } from '@/components/ui/toast';
import { THEME_BOOT_SCRIPT } from '@/lib/theme';
import { displaySerif, uiSans } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'Konusbitr',
  description: 'Open-source, self-hostable document chat with page-accurate citations.',
  icons: {
    icon: [
      { url: '/icon_DARK.svg', media: '(prefers-color-scheme: light)' },
      { url: '/icon_LIGHT.svg', media: '(prefers-color-scheme: dark)' },
    ],
    shortcut: '/icon.svg',
    apple: '/icon_DARK.svg',
  },
};

/**
 * `suppressHydrationWarning` on `<html>` is deliberate and scoped to it: the
 * boot script below writes a `data-theme` attribute React did not render, which
 * is the whole point — a theme applied after hydration is a theme the reader
 * watches flip.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${uiSans.variable} ${displaySerif.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant string from `@/lib/theme` with no interpolation; it has to run synchronously, before first paint, so it cannot be a module. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
