import { auth } from '@/lib/auth/config';

/**
 * Every Better Auth endpoint: sign-up, sign-in, verification, magic links,
 * OAuth callbacks and the whole organization surface.
 *
 * Deliberately not wrapped in `withAuth` — this is where authentication
 * *happens*, so requiring a principal to reach it would be circular. It is one
 * of two paths named in `test/auth/protected-routes.test.ts`'s allowlist.
 * Better Auth applies its own origin check and rate limits underneath.
 */
export async function GET(request: Request): Promise<Response> {
  return auth().handler(request);
}

export async function POST(request: Request): Promise<Response> {
  return auth().handler(request);
}

export const dynamic = 'force-dynamic';
