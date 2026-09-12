import { organizationsOf, scopedDb } from '@konusbitr/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '../db';
import { auth } from './config';
import type { MembershipRole } from './context';

/**
 * Server-component helpers for the pages behind a login.
 *
 * `withAuth` guards route handlers; this guards *pages*. The two resolve the
 * same facts from the same tables, but a page wants a redirect to `/login`
 * where a route handler wants a 401, so they stay separate rather than one
 * pretending to be the other.
 */

export type PageSession = {
  userId: string;
  email: string;
  name: string | null;
  orgId: string;
  role: MembershipRole;
  organizations: { id: string; name: string; slug: string; role: MembershipRole }[];
};

/** The signed-in user and their active organization, or `null`. */
export async function currentSession(): Promise<PageSession | null> {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) return null;

  const orgId = session.session.activeOrganizationId;
  if (!orgId) return null;

  const membership = await scopedDb(db(), orgId).membershipOf(session.user.id);
  if (!membership) return null;

  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name ?? null,
    orgId,
    role: membership.role,
    organizations: await organizationsOf(db(), session.user.id),
  };
}

/** As {@link currentSession}, but sends an anonymous reader to sign in. */
export async function requireSession(returnTo: string): Promise<PageSession> {
  const session = await currentSession();
  if (!session) redirect(`/login?redirect=${encodeURIComponent(returnTo)}`);
  return session;
}
