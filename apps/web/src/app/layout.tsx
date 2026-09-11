import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { displaySerif, uiSans } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'Konusbitr',
  description: 'Open-source, self-hostable document chat with page-accurate citations.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${uiSans.variable} ${displaySerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
