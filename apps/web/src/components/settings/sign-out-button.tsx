'use client';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth/client';

export function SignOutButton() {
  return (
    <Button
      type="button"
      variant="tertiary"
      size="sm"
      onClick={() => {
        void authClient.signOut().then(() => window.location.assign('/login'));
      }}
    >
      Sign out
    </Button>
  );
}
