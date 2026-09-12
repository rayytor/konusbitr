import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell } from '@/components/auth/auth-shell';
import { LoginForm } from '@/components/auth/login-form';
import { SocialButtons } from '@/components/auth/social-buttons';
import { enabledSocialProviders } from '@/lib/auth/config';

export const metadata: Metadata = { title: 'Sign in — Konusbitr' };

/**
 * The providers are read on the server, at request time, so the page renders
 * correctly for a deployment that has no OAuth app configured at all.
 */
export default function LoginPage() {
  const providers = enabledSocialProviders();

  return (
    <AuthShell
      title="Sign in"
      description="Your documents, and the conversations about them."
      footer={
        <>
          No account yet?{' '}
          <Link href="/signup" className="text-accent underline underline-offset-2">
            Create one
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <SocialButtons providers={providers} callbackURL="/settings/api-keys" />
        <LoginForm redirectTo="/settings/api-keys" />
      </div>
    </AuthShell>
  );
}

export const dynamic = 'force-dynamic';
