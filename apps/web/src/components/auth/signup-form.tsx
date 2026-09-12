'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { authClient } from '@/lib/auth/client';

/** Must match `emailAndPassword.minPasswordLength` in the server config. */
const MIN_PASSWORD_LENGTH = 10;

/**
 * Create an account.
 *
 * A successful signup does not sign anyone in: verification is required, so the
 * form ends on a message telling the reader where to look. That is the honest
 * outcome, and hiding it behind an optimistic redirect to a page that would
 * bounce them back is worse.
 *
 * `redirectTo` is therefore not somewhere this form navigates. It is where the
 * verification link in the email lands, so someone who arrived from an
 * invitation finishes on the invitation rather than on the API keys page.
 */
export function SignupForm({ redirectTo }: { redirectTo: string }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setPending(true);
    setError(undefined);

    const result = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: redirectTo,
    });
    setPending(false);

    if (result.error) {
      setError('We could not create that account. Try a different email address.');
      return;
    }

    setDone(true);
  }

  if (done) {
    return (
      <Alert tone="success">
        Check {email} for a link to confirm the address. Your workspace is waiting once you do.
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      <Field id="name" label="Name">
        {(aria) => (
          <Input
            {...aria}
            name="name"
            autoComplete="name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>

      <Field id="email" label="Email">
        {(aria) => (
          <Input
            {...aria}
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        )}
      </Field>

      <Field
        id="password"
        label="Password"
        hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        error={error}
      >
        {(aria) => (
          <Input
            {...aria}
            type="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </Field>

      <Button type="submit" disabled={pending}>
        {pending ? 'Creating your workspace…' : 'Create account'}
      </Button>
    </form>
  );
}
