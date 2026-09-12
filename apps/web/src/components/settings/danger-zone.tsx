'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { authClient } from '@/lib/auth/client';

/**
 * Deleting the workspace — an owner's privilege, and the one action here that
 * cannot be undone.
 *
 * `design.md` asks for a restrained danger colour and confirmation for
 * irreversible actions, so this is a quiet section that only appears for an
 * owner and only arms itself once the workspace name has been typed back. An
 * admin who reaches the endpoint anyway is refused by Better Auth's access
 * control, which is where the rule is actually enforced.
 */
export function DangerZone({ organizationName }: { organizationName: string }) {
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const armed = confirmation.trim() === organizationName;

  async function remove() {
    setPending(true);
    setError(undefined);

    const session = await authClient.getSession();
    const organizationId = session.data?.session.activeOrganizationId;

    if (!organizationId) {
      setPending(false);
      setError('No active workspace to delete.');
      return;
    }

    const result = await authClient.organization.delete({ organizationId });
    setPending(false);

    if (result.error) {
      setError('This workspace could not be deleted. Only its owner can delete it.');
      return;
    }

    window.location.assign('/login');
  }

  return (
    <section className="flex flex-col gap-4 border-t border-border-subtle pt-8">
      <h2 className="font-serif text-[24px] leading-tight">Delete this workspace</h2>
      <p className="max-w-prose text-[15px] leading-relaxed text-foreground-muted">
        Its documents, conversations and API keys go with it. This cannot be undone. Type{' '}
        <span className="text-foreground">{organizationName}</span> to confirm.
      </p>

      <div className="flex max-w-sm flex-col gap-3">
        <label className="sr-only" htmlFor="confirm-delete">
          Workspace name
        </label>
        <Input
          id="confirm-delete"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder={organizationName}
        />

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div>
          <Button
            type="button"
            variant="danger"
            disabled={!armed || pending}
            onClick={() => void remove()}
          >
            {pending ? 'Deleting…' : 'Delete workspace'}
          </Button>
        </div>
      </div>
    </section>
  );
}
