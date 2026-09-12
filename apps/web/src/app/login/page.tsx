import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell } from '@/components/auth/auth-shell';
import { LoginForm } from '@/components/auth/login-form';
import { SocialButtons } from '@/components/auth/social-buttons';
import { enabledSocialProviders } from '@/lib/auth/config';
import { safeRedirect, withRedirect } from '@/lib/auth/redirect';

export const metadata: Metadata = { title: 'Sign in — Konusbitr' };

/**
 * The providers are read on the server, at request time, so the page renders
 * correctly for a deployment that has no OAuth app configured at all.
 *
 * `?redirect=` is where `requireSession` and the invitation page put the page
 * the reader actually asked for. It is sanitised to a same-origin path before it
 * reaches either door, and carried on to signup so that crossing over does not
 * lose it.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string | string[] }>;
}) {
  const providers = enabledSocialProviders();
  const redirectTo = safeRedirect((await searchParams).redirect);

  return (
    <AuthShell
      title="Sign in"
      description="Your documents, and the conversations about them."
      footer={
        <>
          No account yet?{' '}
          <Link
            href={withRedirect('/signup', redirectTo)}
            className="text-accent underline underline-offset-2"
          >
            Create one
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <SocialButtons providers={providers} callbackURL={redirectTo} />
        <LoginForm redirectTo={redirectTo} />
      </div>
    </AuthShell>
  );
}

export const dynamic = 'force-dynamic';
