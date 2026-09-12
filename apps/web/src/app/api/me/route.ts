import { withAuth } from '@/lib/auth/with-auth';

/**
 * Who the caller is, as Konusbitr sees them.
 *
 * Useful on its own — an API client can check a key works without spending
 * credits — and it is the smallest possible demonstration that a session and a
 * key resolve to the same shape.
 */
export const GET = withAuth((_request, auth) =>
  Response.json(
    {
      kind: auth.kind,
      userId: auth.userId ?? null,
      orgId: auth.orgId,
      role: auth.role,
      scopes: auth.scopes,
    },
    { headers: { 'cache-control': 'no-store' } },
  ),
);

export const dynamic = 'force-dynamic';
