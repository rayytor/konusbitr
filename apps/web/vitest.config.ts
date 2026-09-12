import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `tsconfig.json` leaves JSX to Next (`jsx: preserve`), which the transform
  // Vite runs cannot parse on its own. Naming the modern runtime here is what
  // lets a test import a page component and read the tree it returns.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts'],
  },
});
