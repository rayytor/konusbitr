'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth/client';

/**
 * Accept or decline an invitation.
 *
 * Both outcomes are terminal and both are stated plainly. Declining is offered
 * rather than left to closing the tab, because a pending invitation that nobody
 * ever resolves is noise on the inviter's members page.
 */
export function AcceptInvitation({ invitationId }: { invitationId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<'accepted' | 'rejected'>();

  async function respond(accept: boolean) {
    setPending(true);
    setError(undefined);

    const result = accept
      ? await authClient.organization.acceptInvitation({ invitationId })
      : await authClient.organization.rejectInvitation({ invitationId });

    setPending(false);

    if (result.error) {
      setError('This invitation is no longer valid. Ask whoever invited you to send a new one.');
      return;
    }

    setOutcome(accept ? 'accepted' : 'rejected');
  }

  if (outcome === 'accepted') {
    return <Alert tone="success">You have joined the workspace.</Alert>;
  }

  if (outcome === 'rejected') {
    return <Alert tone="info">Invitation declined.</Alert>;
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex gap-2">
        <Button type="button" disabled={pending} onClick={() => void respond(true)}>
          {pending ? 'Joining…' : 'Accept invitation'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => void respond(false)}
        >
          Decline
        </Button>
      </div>
    </div>
  );
}
