import { scopedDb } from '@konusbitr/db';
import { z } from 'zod';
import { listProviderKeyViews, upsertProviderKeyRecord } from '@/lib/auth/provider-keys';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';
import { loadWebEnv } from '@/lib/env';

/**
 * Organization-scoped Model Provider API keys (e.g. OpenAI, Anthropic, Google).
 *
 * Both handlers require an authenticated admin/owner session: managing model provider
 * credentials affects the entire organization's billing and model access.
 * API keys cannot call these endpoints.
 */

const UpsertProviderKeySchema = z.object({
  id: z.string().trim().optional(),
  provider: z.string().trim().min(1).max(50),
  key: z.string().trim().min(1).max(500),
  label: z.string().trim().max(80).optional(),
  baseUrl: z.union([z.string().trim().url(), z.literal('')]).optional(),
});

export const GET = withAuth(
  async (_request, auth) => {
    const org = await scopedDb(db(), auth.orgId).organization();
    const keys = listProviderKeyViews(org?.settings);
    return Response.json({ keys }, { headers: { 'cache-control': 'no-store' } });
  },
  { role: 'admin', allowApiKey: false },
);

export const POST = withAuth(
  async (request, auth) => {
    const body = await request.json().catch(() => null);
    const parsed = UpsertProviderKeySchema.safeParse(body);

    if (!parsed.success) {
      return Response.json(
        {
          error: {
            code: 'invalid_request',
            message: 'A provider and valid API key are required.',
          },
        },
        { status: 400 },
      );
    }

    const env = loadWebEnv();
    const scoped = scopedDb(db(), auth.orgId);
    const org = await scoped.organization();

    const { updatedSettings, view } = upsertProviderKeyRecord(org?.settings, {
      id: parsed.data.id,
      provider: parsed.data.provider,
      key: parsed.data.key,
      label: parsed.data.label,
      baseUrl: parsed.data.baseUrl || null,
      authSecret: env.AUTH_SECRET,
    });

    await scoped.updateOrganizationSettings(updatedSettings);

    return Response.json({ key: view }, { status: 200, headers: { 'cache-control': 'no-store' } });
  },
  { role: 'admin', allowApiKey: false },
);

export const dynamic = 'force-dynamic';
