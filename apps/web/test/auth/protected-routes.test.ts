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
 * The Hono-mounted surfaces, which resolve a principal a different way.
 *
 * `/v2` and `/v1` are one catch-all route file each, and authentication lives
 * inside the app they hand off to — `lib/v2/mount.ts` resolves the context and
 * checks the scope for every declared route, which is the same guarantee
 * `withAuth` gives by a different mechanism. They are walked separately below
 * rather than exempted, because "this file is allowed to skip auth" is exactly
 * the sentence this test exists to refuse.
 */
const HONO_ROOTS = [
  fileURLToPath(new URL('../../src/app/v2', import.meta.url)),
  fileURLToPath(new URL('../../src/app/v1', import.meta.url)),
];

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

describe('the Hono-mounted public API', () => {
  it('hands every route file off to an app rather than handling requests itself', async () => {
    for (const root of HONO_ROOTS) {
      const files = await routeFiles(root);
      expect(files.length, `${root} has no route file`).toBeGreaterThan(0);

      for (const path of files) {
        const source = await readFile(path, 'utf8');
        // `handle(app)` and nothing else: a handler written inline here would
        // sit outside the middleware chain that does the authenticating.
        expect(source, `${path} exports a handler that is not the Hono app`).toMatch(
          /export const (GET|POST|DELETE|PUT|PATCH) = handle\(app\);/,
        );
        expect(source).not.toMatch(/export\s+(async\s+)?function\s+(GET|POST|DELETE)\b/);
      }
    }
  });

  it('resolves a principal and checks the scope for every declared route', async () => {
    const mountSource = await readFile(
      fileURLToPath(new URL('../../src/lib/v2/mount.ts', import.meta.url)),
      'utf8',
    );
    expect(mountSource).toMatch(/resolveAuthContext\(/);
    expect(mountSource).toMatch(/missingScope\(/);
  });

  it('declares a scope on every route it mounts', async () => {
    const { ALL_ROUTES } = await import('@/lib/v2/app');
    expect(ALL_ROUTES.length).toBeGreaterThanOrEqual(9);

    for (const { definition } of ALL_ROUTES) {
      expect(
        definition.scopes.length,
        `${definition.operationId} declares no scope, so any key could call it`,
      ).toBeGreaterThan(0);
    }
  });
});
