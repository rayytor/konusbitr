import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repository's single `.env`, read for the end-to-end run.
 *
 * Konusbitr keeps one environment file at the root because both runtimes and
 * Compose read it. Playwright starts the web server itself, so it has to load
 * the same file rather than inventing a second one that would drift.
 *
 * Deliberately a five-line parser instead of a dependency: this reads
 * `KEY=value`, ignores comments and blank lines, and does nothing else. A test
 * harness that needs shell-style quoting and interpolation to start is a test
 * harness with a configuration problem.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function loadRootEnv(): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(join(ROOT, '.env'), 'utf8');
  } catch {
    return {};
  }

  const values: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals === -1) continue;
    values[trimmed.slice(0, equals).trim()] = trimmed
      .slice(equals + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return values;
}

/** `.env` first, then anything the shell or CI already set, which wins. */
export function mergedEnv(): Record<string, string> {
  const merged: Record<string, string> = { ...loadRootEnv() };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

export const MODEL_STUB_PORT = Number(process.env.MODEL_STUB_PORT ?? 4010);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
export const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
