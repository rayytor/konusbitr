import { scopedDb } from '@konusbitr/db';
import { removeProviderKeyRecord } from '@/lib/auth/provider-keys';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';

/**
 * Remove a model provider API key from the organization.
 */
export const DELETE = withAuth<{ keyId: string }>(
  async (_request, auth, { params }) => {
    const { keyId } = await params;
    const scoped = scopedDb(db(), auth.orgId);
    const org = await scoped.organization();

    const { updatedSettings, removed } = removeProviderKeyRecord(org?.settings, keyId);

    if (!removed) {
      return Response.json(
        { error: { code: 'not_found', message: 'No provider key with that identifier.' } },
        { status: 404 },
      );
    }

    await scoped.updateOrganizationSettings(updatedSettings);

    return new Response(null, { status: 204 });
  },
  { role: 'admin', allowApiKey: false },
);

export const dynamic = 'force-dynamic';
