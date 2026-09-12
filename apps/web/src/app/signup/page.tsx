import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell } from '@/components/auth/auth-shell';
import { SignupForm } from '@/components/auth/signup-form';
import { SocialButtons } from '@/components/auth/social-buttons';
import { enabledSocialProviders } from '@/lib/auth/config';
import { safeRedirect, withRedirect } from '@/lib/auth/redirect';

export const metadata: Metadata = { title: 'Create an account — Konusbitr' };

/**
 * As with `/login`, `?redirect=` names the page the reader was heading for —
 * an invitation, most often, which is exactly the link that sends a stranger to
 * signup rather than to sign-in. It reaches OAuth as the callback URL and email
 * signup as the address the verification link comes back to.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string | string[] }>;
}) {
  const providers = enabledSocialProviders();
  const redirectTo = safeRedirect((await searchParams).redirect);

  return (
    <AuthShell
      title="Create an account"
      description="You will get a workspace of your own to start with."
      footer={
        <>
          Already have an account?{' '}
          <Link
            href={withRedirect('/login', redirectTo)}
            className="text-accent underline underline-offset-2"
          >
            Sign in
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <SocialButtons providers={providers} callbackURL={redirectTo} />
        <SignupForm redirectTo={redirectTo} />
      </div>
    </AuthShell>
  );
}

export const dynamic = 'force-dynamic';
