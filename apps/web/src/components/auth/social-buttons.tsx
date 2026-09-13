'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth/client';

/**
 * OAuth sign-in, for whichever providers the deployment configured.
 *
 * The server decides which providers exist and passes them in; this component
 * renders nothing at all when the list is empty. That is what makes "with no
 * OAuth env vars set, the login page renders and works" true — there is no
 * disabled button to click and no divider left dangling above an empty row.
 */
const LABELS: Record<string, string> = { google: 'Google', github: 'GitHub' };

export function SocialButtons({
  providers,
  callbackURL,
}: {
  providers: readonly string[];
  callbackURL: string;
}) {
  const [pending, setPending] = useState<string | null>(null);

  if (providers.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {providers.map((provider) => (
          <Button
            key={provider}
            type="button"
            variant="secondary"
            disabled={pending !== null}
            onClick={() => {
              setPending(provider);
              void authClient.signIn
                .social({ provider: provider as 'google' | 'github', callbackURL })
                .finally(() => setPending(null));
            }}
          >
            Continue with {LABELS[provider] ?? provider}
          </Button>
        ))}
      </div>

      <div className="flex items-center gap-3 text-[13px] text-foreground-subtle">
        <span className="h-px flex-1 bg-border-subtle" />
        or
        <span className="h-px flex-1 bg-border-subtle" />
      </div>
    </div>
  );
}
