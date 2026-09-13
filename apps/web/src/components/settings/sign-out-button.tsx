'use client';

import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { authClient } from '@/lib/auth/client';

function signOut() {
  void authClient.signOut().then(() => window.location.assign('/login'));
}

/**
 * Sign out.
 *
 * In the sidebar footer this is `iconOnly`: the footer's job is to say who you
 * are, and a word-shaped button next to the appearance icons reads as the loud
 * thing in a quiet corner. `IconButton` still gives it a name and a tooltip.
 */
export function SignOutButton({
  iconOnly = false,
  className,
}: {
  iconOnly?: boolean;
  className?: string;
}) {
  if (iconOnly) {
    return (
      <IconButton
        icon={LogOut}
        label="Sign out"
        side="top"
        variant="tertiary"
        onClick={signOut}
        className={className}
      />
    );
  }

  return (
    <Button type="button" variant="tertiary" size="sm" onClick={signOut} className={className}>
      Sign out
    </Button>
  );
}
