import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { AcceptInvitation } from '@/components/auth/accept-invitation';
import { AuthShell } from '@/components/auth/auth-shell';
import { auth } from '@/lib/auth/config';
import { withRedirect } from '@/lib/auth/redirect';

export const metadata: Metadata = { title: 'Join a workspace — Konusbitr' };

/**
 * The landing page for an invitation link.
 *
 * Accepting requires a session, because an invitation attaches a *user* to an
 * organization. Someone arriving without one is sent to sign in rather than
 * shown a button that would fail — and the invitation id stays in the URL, so
 * coming back lands here again.
 */
export default async function AcceptInvitationPage({
  params,
}: {
  params: Promise<{ invitationId: string }>;
}) {
  const { invitationId } = await params;
  const session = await auth().api.getSession({ headers: await headers() });

  if (!session) {
    return (
      <AuthShell
        title="You have been invited"
        description="Sign in, or create an account with the address the invitation was sent to, and you will land back here."
      >
        <Link
          href={withRedirect('/login', `/accept-invitation/${encodeURIComponent(invitationId)}`)}
          className="text-accent underline underline-offset-2"
        >
          Sign in to continue
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="You have been invited"
      description={`Accepting joins this workspace as ${session.user.email}.`}
    >
      <AcceptInvitation invitationId={invitationId} />
    </AuthShell>
  );
}

export const dynamic = 'force-dynamic';
