'use client';

import { useState } from 'react';

/**
 * A button or link that bypasses account creation by provisioning an instant guest workspace.
 */
export function SkipButton({ redirectTo, className }: { redirectTo: string; className?: string }) {
  const [skipping, setSkipping] = useState(false);

  async function handleSkip() {
    setSkipping(true);
    try {
      const response = await fetch('/api/auth/sign-in/guest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error('Guest sign-in failed');
      window.location.assign(redirectTo);
    } catch {
      setSkipping(false);
    }
  }

  return (
    <button
      type="button"
      disabled={skipping}
      onClick={handleSkip}
      className={
        className ??
        'cursor-pointer text-[15px] text-foreground-muted hover:text-foreground disabled:opacity-50'
      }
    >
      {skipping ? 'Entering…' : 'Skip \u2192'}
    </button>
  );
}
