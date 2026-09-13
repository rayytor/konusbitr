#!/usr/bin/env node
/**
 * Copy PDF.js's runtime data into `apps/web/public/pdfjs`.
 *
 * PDF.js keeps three things outside its JavaScript bundle and fetches them by
 * URL at render time: character maps for CJK and other non-Latin encodings, the
 * metrics for the fourteen standard PDF fonts, and the WASM image decoders
 * (JPEG 2000, OpenJPEG). Point them at a CDN — which is what every tutorial
 * does — and a self-hosted, privacy-first document tool quietly makes a
 * third-party request the first time someone opens a Japanese PDF, and renders
 * nothing at all on an air-gapped instance.
 *
 * So they are copied into `public/` at build time from the installed package,
 * which keeps them version-locked to the `pdfjs-dist` in the lockfile. They are
 * not committed; this script runs before `dev` and before `build`.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const web = join(root, 'apps', 'web');

// Resolved from `apps/web`, not from the repository root: pnpm's node_modules
// is strict, and `pdfjs-dist` is a dependency of the web app alone.
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json', { paths: [web] }));
const destination = join(web, 'public', 'pdfjs');

const DIRECTORIES = ['cmaps', 'standard_fonts', 'wasm'];

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

for (const directory of DIRECTORIES) {
  await cp(join(pdfjsRoot, directory), join(destination, directory), { recursive: true });
}

// biome-ignore lint/suspicious/noConsole: build script output
console.log(`pdfjs assets → ${destination} (${DIRECTORIES.join(', ')})`);
