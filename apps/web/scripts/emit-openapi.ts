/**
 * Write the generated OpenAPI 3.1 document to `docs/openapi.json`.
 *
 * The committed file is what both SDKs are generated from and what a developer
 * reads without running the stack. It is *generated*, never edited: `pnpm
 * openapi:check` regenerates it and diffs, and CI runs that — so a route whose
 * schema changed and whose spec did not cannot be merged. That is the phase's
 * "CI fails if the spec drifts from the code" criterion, implemented the same
 * way `pnpm codegen` keeps the Python contract honest.
 *
 * The server URL is a placeholder rather than this machine's `APP_URL`: the
 * committed document describes the API, not one deployment of it, and baking in
 * whatever was in somebody's `.env` would make the file differ per contributor.
 * The document served live at `/v2/openapi.json` carries the real origin.
 *
 * Usage: `tsx scripts/emit-openapi.ts [output-path]`
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { specFor } from '../src/lib/v2/app';

const DEFAULT_OUTPUT = fileURLToPath(new URL('../../../docs/openapi.json', import.meta.url));

/** The documented base URL. A self-hoster substitutes their own origin. */
const PLACEHOLDER_SERVER = 'https://konusbitr.example.com';

const output = resolve(process.argv[2] ?? DEFAULT_OUTPUT);
const document = specFor(PLACEHOLDER_SERVER);

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

// biome-ignore lint/suspicious/noConsole: CLI output
console.log(`openapi: wrote ${output}`);
