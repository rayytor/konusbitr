import { handle } from 'hono/vercel';
import { createV2App } from '@/lib/v2/app';

/**
 * The public `/v2` API, mounted into Next.js.
 *
 * One catch-all route file, because Hono owns the routing below this point.
 * That is what lets `/v2` be lifted into its own deployment later without
 * touching a handler: the app object is complete on its own and this file is
 * four lines of adapter.
 *
 * Authentication lives in `lib/v2/mount.ts` rather than in `withAuth`, and
 * `test/auth/protected-routes.test.ts` knows that — it checks every route under
 * `src/app/v2` for the Hono chain instead, so an endpoint added without a
 * principal still turns the suite red.
 */
const app = createV2App();

export const GET = handle(app);
export const POST = handle(app);
export const DELETE = handle(app);

// Streaming request bodies and per-request authentication: nothing here may be
// statically rendered or cached.
export const dynamic = 'force-dynamic';
