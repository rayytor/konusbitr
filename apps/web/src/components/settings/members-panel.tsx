'use client';

import { MailPlus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { authClient } from '@/lib/auth/client';
import type { MembershipRole } from '@/lib/auth/context';

export type MemberView = {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: MembershipRole;
};

export type InvitationView = {
  id: string;
  email: string;
  role: MembershipRole | null;
  expiresAt: string;
};

const ROLES: MembershipRole[] = ['member', 'admin', 'owner'];

const ROLE_DESCRIPTIONS: Record<MembershipRole, string> = {
  owner: 'Billing, and deleting the workspace.',
  admin: 'Members, API keys and settings.',
  member: 'Documents and chats.',
};

/**
 * The team surface: invite, change a role, remove a member.
 *
 * Every control here is gated twice — once in this component so nobody is shown
 * a button that will fail, and once on the server by Better Auth's access
 * control, which is the check that actually matters. The two are kept in step
 * by `viewerRole`, which comes from the same `memberships` row the server reads.
 */
export function MembersPanel({
  members,
  invitations,
  viewerRole,
  viewerUserId,
}: {
  members: MemberView[];
  invitations: InvitationView[];
  viewerRole: MembershipRole;
  viewerUserId: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MembershipRole>('member');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const canManage = viewerRole === 'owner' || viewerRole === 'admin';

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    setNotice(undefined);

    const result = await authClient.organization.inviteMember({ email, role });
    setPending(false);

    if (result.error) {
      setError('We could not send that invitation. Check the address and try again.');
      return;
    }

    setNotice(`Invitation sent to ${email}.`);
    setEmail('');
    router.refresh();
  }

  async function changeRole(member: MemberView, next: MembershipRole) {
    setError(undefined);
    const result = await authClient.organization.updateMemberRole({
      memberId: member.id,
      role: next,
    });
    if (result.error) {
      setError('That role change was refused. You may not have permission to make it.');
      return;
    }
    router.refresh();
  }

  async function remove(member: MemberView) {
    const confirmed = window.confirm(
      `Remove ${member.email} from this workspace? They lose access to its documents immediately.`,
    );
    if (!confirmed) return;

    const result = await authClient.organization.removeMember({ memberIdOrEmail: member.id });
    if (result.error) {
      setError('That member could not be removed.');
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-10">
      {canManage ? (
        <form onSubmit={invite} className="flex flex-col gap-5">
          <h2 className="font-serif text-[24px] leading-tight">Invite someone</h2>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="flex-1">
              <Field id="invite-email" label="Email">
                {(aria) => (
                  <Input
                    {...aria}
                    type="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                )}
              </Field>
            </div>

            <div className="sm:w-44">
              <Field id="invite-role" label="Role" hint={ROLE_DESCRIPTIONS[role]}>
                {(aria) => (
                  <select
                    {...aria}
                    value={role}
                    onChange={(event) => setRole(event.target.value as MembershipRole)}
                    className="h-10 w-full cursor-pointer rounded-[var(--radius-sm)] border border-border bg-surface px-3 text-[15px] focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {ROLES.filter((value) => viewerRole === 'owner' || value !== 'owner').map(
                      (value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ),
                    )}
                  </select>
                )}
              </Field>
            </div>
          </div>

          {error ? <Alert tone="error">{error}</Alert> : null}
          {notice ? <Alert tone="success">{notice}</Alert> : null}

          <div>
            <Button type="submit" disabled={pending || email.trim() === ''}>
              <MailPlus aria-hidden />
              {pending ? 'Sending…' : 'Send invitation'}
            </Button>
          </div>
        </form>
      ) : null}

      <section className="flex flex-col gap-4">
        <h2 className="font-serif text-[24px] leading-tight">Members</h2>
        <ul className="flex flex-col divide-y divide-border-subtle">
          {members.map((member) => (
            <li key={member.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px]">{member.name ?? member.email}</p>
                <p className="truncate text-[13px] text-foreground-subtle">{member.email}</p>
              </div>

              {canManage && member.userId !== viewerUserId ? (
                <>
                  <label className="sr-only" htmlFor={`role-${member.id}`}>
                    Role for {member.email}
                  </label>
                  <select
                    id={`role-${member.id}`}
                    value={member.role}
                    onChange={(event) =>
                      void changeRole(member, event.target.value as MembershipRole)
                    }
                    className="h-8 cursor-pointer rounded-[var(--radius-sm)] border border-border bg-surface px-2 text-[15px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {ROLES.filter((value) => viewerRole === 'owner' || value !== 'owner').map(
                      (value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ),
                    )}
                  </select>

                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => void remove(member)}
                  >
                    <Trash2 aria-hidden />
                    Remove
                  </Button>
                </>
              ) : (
                <span className="text-[13px] text-foreground-muted">{member.role}</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {invitations.length > 0 ? (
        <section className="flex flex-col gap-4">
          <h2 className="font-serif text-[24px] leading-tight">Pending invitations</h2>
          <ul className="flex flex-col divide-y divide-border-subtle">
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3"
              >
                <span className="text-[15px]">{invitation.email}</span>
                <span className="text-[13px] text-foreground-muted">
                  {invitation.role ?? 'member'} · expires{' '}
                  {new Date(invitation.expiresAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
