import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { currentSession } from '@/lib/auth/session';

/**
 * The front door.
 *
 * Still a placeholder — the library and the viewer arrive in Phase 11 — but it
 * now knows whether anyone is signed in, so the two entry points this phase
 * built are reachable from it.
 */
export default async function HomePage() {
  const session = await currentSession();

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-16">
      <h1 className="font-serif text-5xl leading-tight tracking-tight">Konusbitr</h1>
      <p className="mt-4 max-w-prose text-base leading-relaxed text-foreground-muted">
        Open-source, self-hostable document chat with page-accurate citations.
      </p>

      <div className="mt-8 flex items-center gap-3">
        {session ? (
          <>
            <Button asChild>
              <Link href="/settings/api-keys">Open settings</Link>
            </Button>
            <span className="text-[13px] text-foreground-muted">Signed in as {session.email}</span>
          </>
        ) : (
          <>
            <Button asChild>
              <Link href="/signup">Create an account</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/login">Sign in</Link>
            </Button>
          </>
        )}
      </div>
    </main>
  );
}

export const dynamic = 'force-dynamic';
