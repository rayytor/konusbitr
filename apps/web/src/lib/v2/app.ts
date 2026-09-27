import { Hono } from 'hono';
import { loadWebEnv } from '@/lib/env';
import { APP_VERSION } from '@/lib/version';
import { docsPage } from './docs-page';
import { mount, type RouteImplementation } from './mount';
import { openapiDocument } from './openapi';
import { askRoute } from './routes/ask';
import { deleteDocumentRoute, getDocumentRoute } from './routes/documents';
import { extractRoute } from './routes/extract';
import { getJobRoute } from './routes/jobs';
import { chatWithAllPdfsRoute, chatWithPdfRoute } from './routes/legacy';
import { parseRoute } from './routes/parse';
import { splitRoute } from './routes/split';

/**
 * The public API, assembled.
 *
 * Hono rather than more Next.js route handlers, and the reason is not speed.
 * It is that `/v2` is a *separable* thing: it has its own authentication story,
 * its own error envelope, its own rate limits and its own generated document,
 * and somebody will eventually want to run it as its own deployment in front of
 * the same database. An app object with its own middleware chain can be lifted
 * out; twenty files under `src/app/api` cannot.
 *
 * Everything below is declaration. The behaviour lives in `mount.ts`, which is
 * the only file that knows about Hono at all.
 */

/** Every `/v2` route, in the order the generated document lists them. */
export const V2_ROUTES: readonly RouteImplementation<never>[] = [
  parseRoute,
  extractRoute,
  splitRoute,
  askRoute,
  getDocumentRoute,
  deleteDocumentRoute,
  getJobRoute,
] as readonly RouteImplementation<never>[];

/** The legacy PDF.ai-compatible endpoints, mounted under `/v1`. */
export const V1_ROUTES: readonly RouteImplementation<never>[] = [
  chatWithPdfRoute,
  chatWithAllPdfsRoute,
] as readonly RouteImplementation<never>[];

/** Every route, for the one document that describes the whole surface. */
export const ALL_ROUTES = [...V2_ROUTES, ...V1_ROUTES];

/** The generated OpenAPI 3.1 document for this instance. */
export function specFor(appUrl: string): Record<string, unknown> {
  return openapiDocument(ALL_ROUTES, { version: APP_VERSION, serverUrl: appUrl });
}

export function createV2App(): Hono {
  const app = new Hono().basePath('/v2');

  // Both unauthenticated, and deliberately so: a specification is a public
  // document, and requiring a key to read the description of how to get a key
  // would be a circle. Neither touches the database or names a tenant.
  app.get('/openapi.json', (c) =>
    c.json(specFor(loadWebEnv().APP_URL), 200, {
      'cache-control': 'public, max-age=300',
    }),
  );

  app.get('/docs', (c) =>
    c.html(docsPage(), 200, {
      'cache-control': 'public, max-age=300',
    }),
  );

  mount(app, V2_ROUTES);
  return app;
}

export function createV1App(): Hono {
  const app = new Hono().basePath('/v1');
  mount(app, V1_ROUTES);
  return app;
}
