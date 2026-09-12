import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell } from '@/components/auth/auth-shell';
import { SignupForm } from '@/components/auth/signup-form';
import { SocialButtons } from '@/components/auth/social-buttons';
import { enabledSocialProviders } from '@/lib/auth/config';

export const metadata: Metadata = { title: 'Create an account — Konusbitr' };

export default function SignupPage() {
  const providers = enabledSocialProviders();

  return (
    <AuthShell
      title="Create an account"
      description="You will get a workspace of your own to start with."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className="text-accent underline underline-offset-2">
            Sign in
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <SocialButtons providers={providers} callbackURL="/settings/api-keys" />
        <SignupForm />
      </div>
    </AuthShell>
  );
}

export const dynamic = 'force-dynamic';
