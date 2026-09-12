import { scopedDb } from '@konusbitr/db';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';

/**
 * Revoke a key.
 *
 * Revocation is a timestamp, not a delete: the row stays so that the key's
 * prefix and last use remain visible afterwards, which is what an operator
 * wants when working out what a leaked key touched. `resolveApiKey` rejects any
 * key with `revoked_at` set, so the effect is immediate.
 */
export const DELETE = withAuth<{ keyId: string }>(
  async (_request, auth, { params }) => {
    const { keyId } = await params;
    const revoked = await scopedDb(db(), auth.orgId).revokeApiKey(keyId);

    if (!revoked) {
      return Response.json(
        { error: { code: 'not_found', message: 'No active key with that id.' } },
        { status: 404 },
      );
    }

    return new Response(null, { status: 204 });
  },
  { role: 'admin', allowApiKey: false },
);

export const dynamic = 'force-dynamic';
