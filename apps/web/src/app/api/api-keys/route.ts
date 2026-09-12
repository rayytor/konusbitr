import { scopedDb } from '@konusbitr/db';
import { z } from 'zod';
import { generateApiKey } from '@/lib/auth/api-key';
import { API_SCOPES } from '@/lib/auth/scopes';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';

/**
 * The organization's API keys.
 *
 * Both handlers are `allowApiKey: false` and `role: 'admin'`: minting and
 * listing credentials is account management, so it takes a signed-in admin. A
 * key that could mint another key would make revocation meaningless.
 */

const CreateKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
  /** Optional expiry, as an ISO timestamp. Absent means the key never expires. */
  expiresAt: z.iso.datetime().optional(),
});

/** A key as the client may see it: everything except the secret. */
type PresentableKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

function present(row: PresentableKey) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export const GET = withAuth(
  async (_request, auth) => {
    const keys = await scopedDb(db(), auth.orgId).listApiKeys();
    return Response.json({ keys: keys.map(present) }, { headers: { 'cache-control': 'no-store' } });
  },
  { role: 'admin', allowApiKey: false },
);

export const POST = withAuth(
  async (request, auth) => {
    const parsed = CreateKeySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json(
        {
          error: {
            code: 'invalid_request',
            message: 'A name and at least one scope are required.',
          },
        },
        { status: 400 },
      );
    }

    const generated = generateApiKey();
    const row = await scopedDb(db(), auth.orgId).createApiKey({
      name: parsed.data.name,
      hashedKey: generated.hashedKey,
      prefix: generated.prefix,
      scopes: parsed.data.scopes,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    });

    if (!row) {
      return Response.json(
        { error: { code: 'internal', message: 'The key could not be created.' } },
        { status: 500 },
      );
    }

    // The only moment the secret leaves the server. Nothing stores it in a form
    // it can be read back from, so a lost key is reissued, never recovered.
    return Response.json(
      { key: present(row), token: generated.token },
      { status: 201, headers: { 'cache-control': 'no-store' } },
    );
  },
  { role: 'admin', allowApiKey: false },
);

export const dynamic = 'force-dynamic';
