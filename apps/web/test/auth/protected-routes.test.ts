import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every route under `src/app/api` resolves an `AuthContext`.
 *
 * This is the acceptance criterion that a route added without `withAuth` fails
 * the test. It walks the real filesystem rather than an import graph on
 * purpose: a route file is discovered by Next.js by *existing*, so that is what
 * this has to discover too. Adding `src/app/api/documents/route.ts` with a bare
 * `export async function GET` turns this red on the first run.
 *
 * The only way past it is to name the route below, which makes "this endpoint
 * is public" a line in a diff that a reviewer sees.
 */
const API_ROOT = fileURLToPath(new URL('../../src/app/api', import.meta.url));

/**
 * Routes that are deliberately unauthenticated, each with the reason it has to
 * be. Both are load-bearing: one is how a container reports itself healthy, and
 * the other is where authentication happens, so requiring a principal to reach
 * it would be circular.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  'health/route.ts': 'liveness probe — no I/O, no data, called by Docker and Compose',
  'auth/[...all]/route.ts': 'Better Auth itself; it applies its own origin check and rate limits',
};

/** Every HTTP method Next.js will route to. */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

async function routeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await routeFiles(path)));
    else if (entry.name === 'route.ts' || entry.name === 'route.tsx') found.push(path);
  }

  return found;
}

const files = await routeFiles(API_ROOT);
const routes = files.map((path) => ({
  path,
  id: relative(API_ROOT, path).split(sep).join('/'),
}));

describe('protected routes', () => {
  it('finds the API routes at all, so an empty walk cannot pass vacuously', () => {
    expect(routes.length).toBeGreaterThanOrEqual(4);
    expect(routes.map((route) => route.id)).toContain('me/route.ts');
  });

  it.each(routes)('$id resolves an AuthContext', async ({ id, path }) => {
    const source = await readFile(path, 'utf8');

    const exportsAMethod = METHODS.some((method) =>
      new RegExp(`export\\s+(const|async\\s+function|function)\\s+${method}\\b`).test(source),
    );
    if (!exportsAMethod) return;

    if (id in PUBLIC_ROUTES) {
      // A route on the allowlist must not also be wrapped — that would mean the
      // allowlist entry is stale and nobody noticed.
      expect(source, `${id} is on the public allowlist but uses withAuth`).not.toMatch(
        /\bwithAuth\s*[(<]/,
      );
      return;
    }

    expect(
      source,
      [
        `${id} exports a route handler without withAuth.`,
        'Wrap it, or — if it genuinely must be public — add it to PUBLIC_ROUTES',
        'in this test with the reason.',
      ].join(' '),
    ).toMatch(/\bwithAuth\s*[(<]/);
  });

  it('has no stale entries on the public allowlist', () => {
    const ids = new Set(routes.map((route) => route.id));
    for (const id of Object.keys(PUBLIC_ROUTES)) {
      expect(ids, `${id} is allowlisted but no longer exists`).toContain(id);
    }
  });
});
