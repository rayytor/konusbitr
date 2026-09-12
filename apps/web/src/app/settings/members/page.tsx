import { scopedDb } from '@konusbitr/db';
import type { Metadata } from 'next';
import { DangerZone } from '@/components/settings/danger-zone';
import {
  type InvitationView,
  MembersPanel,
  type MemberView,
} from '@/components/settings/members-panel';
import { SettingsShell } from '@/components/settings/settings-shell';
import { requireSession } from '@/lib/auth/session';
import { db } from '@/lib/db';

export const metadata: Metadata = { title: 'Members — Konusbitr' };

export default async function MembersPage() {
  const session = await requireSession('/settings/members');
  const scoped = scopedDb(db(), session.orgId);

  const members: MemberView[] = (await scoped.members()).map((row) => ({
    id: row.id,
    userId: row.userId,
    email: row.email,
    name: row.name,
    role: row.role,
  }));

  // Pending invitations name people who have not joined yet, so they are only
  // shown to the roles that can act on them.
  const canManage = session.role === 'owner' || session.role === 'admin';
  const invitations: InvitationView[] = canManage
    ? (await scoped.pendingInvitations()).map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        expiresAt: row.expiresAt.toISOString(),
      }))
    : [];

  return (
    <SettingsShell
      session={session}
      active="/settings/members"
      title="Members"
      description="Who can reach this workspace, and what they can do in it."
    >
      <div className="flex flex-col gap-12">
        <MembersPanel
          members={members}
          invitations={invitations}
          viewerRole={session.role}
          viewerUserId={session.userId}
        />
        {session.role === 'owner' ? <DangerZone organizationName={orgName(session)} /> : null}
      </div>
    </SettingsShell>
  );
}

function orgName(session: {
  orgId: string;
  organizations: { id: string; name: string }[];
}): string {
  return session.organizations.find((org) => org.id === session.orgId)?.name ?? 'this workspace';
}

export const dynamic = 'force-dynamic';
