import { scopedDb } from '@konusbitr/db';
import type { Metadata } from 'next';
import { ApiKeysPanel, type ApiKeyView } from '@/components/settings/api-keys-panel';
import { SettingsShell } from '@/components/settings/settings-shell';
import { requireSession } from '@/lib/auth/session';
import { db } from '@/lib/db';

export const metadata: Metadata = { title: 'API keys — Konusbitr' };

/**
 * Keys are listed on the server so the page is useful on first paint, then
 * handed to a client component that owns creation and revocation.
 *
 * A `member` is shown the page but not the keys: managing credentials is an
 * admin's job, and the same rule is enforced independently by `withAuth` on the
 * routes underneath, so this check is about not showing a dead form rather than
 * about security.
 */
export default async function ApiKeysPage() {
  const session = await requireSession('/settings/api-keys');
  const canManage = session.role === 'owner' || session.role === 'admin';

  const keys: ApiKeyView[] = canManage
    ? (await scopedDb(db(), session.orgId).listApiKeys()).map((key) => ({
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        scopes: key.scopes,
        lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
        expiresAt: key.expiresAt?.toISOString() ?? null,
        revokedAt: key.revokedAt?.toISOString() ?? null,
        createdAt: key.createdAt.toISOString(),
      }))
    : [];

  return (
    <SettingsShell
      session={session}
      title="API keys"
      description="Keys authenticate requests to the Konusbitr API. Each one carries the scopes you give it and nothing more."
    >
      {canManage ? (
        <ApiKeysPanel initialKeys={keys} />
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
