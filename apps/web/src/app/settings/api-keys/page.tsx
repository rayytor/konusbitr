import { scopedDb } from '@konusbitr/db';
import type { Metadata } from 'next';
import { ApiKeysPanel, type ApiKeyView } from '@/components/settings/api-keys-panel';
import { SettingsShell } from '@/components/settings/settings-shell';
import { listProviderKeyViews, type ProviderKeyView } from '@/lib/auth/provider-keys';
import { requireSession } from '@/lib/auth/session';
import { db } from '@/lib/db';

export const metadata: Metadata = { title: 'API keys — Konusbitr' };

/**
 * Keys are listed on the server so the page is useful on first paint, then
 * handed to a client component that owns creation and revocation.
 *
 * Separated into two distinct categories:
 * 1. Konusbitr API keys — inbound access to Konusbitr's API.
 * 2. Model provider API keys — outbound credentials for LLM providers (e.g. OpenAI).
 *
 * A `member` is shown the page but not the keys: managing credentials is an
 * admin's job.
 */
export default async function ApiKeysPage() {
  const session = await requireSession('/settings/api-keys');
  const canManage = session.role === 'owner' || session.role === 'admin';

  let konusbitrKeys: ApiKeyView[] = [];
  let providerKeys: ProviderKeyView[] = [];

  if (canManage) {
    const scoped = scopedDb(db(), session.orgId);
    const [rawApiKeys, org] = await Promise.all([scoped.listApiKeys(), scoped.organization()]);

    konusbitrKeys = rawApiKeys.map((key) => ({
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      scopes: key.scopes,
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
      expiresAt: key.expiresAt?.toISOString() ?? null,
      revokedAt: key.revokedAt?.toISOString() ?? null,
      createdAt: key.createdAt.toISOString(),
    }));

    providerKeys = listProviderKeyViews(org?.settings);
  }

  return (
    <SettingsShell
      session={session}
      title="API keys"
      description="Manage Konusbitr API keys for programmatic access, and configure external model provider API keys (OpenAI, Anthropic, etc.) for this workspace."
    >
      {canManage ? (
        <ApiKeysPanel initialKonusbitrKeys={konusbitrKeys} initialProviderKeys={providerKeys} />
      ) : (
        <p className="text-[15px] leading-relaxed text-foreground-muted">
          Only an owner or an admin can manage API keys. Ask someone with that role in this
          workspace.
        </p>
      )}
    </SettingsShell>
  );
}

export const dynamic = 'force-dynamic';
