import { APP_VERSION } from '@/lib/version';

/** Liveness probe. Deliberately unauthenticated and free of any I/O. */
export function GET(): Response {
  return Response.json(
    { ok: true, version: APP_VERSION },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export const dynamic = 'force-dynamic';
