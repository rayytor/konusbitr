'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { authClient } from '@/lib/auth/client';

type Mode = 'password' | 'magic-link';

/**
 * Sign-in, with both doors that need no OAuth app: a password and a link in an
 * email.
 *
 * Failures are reported in the words `design.md` §23 asks for — what happened
 * and what to do — and never in the words the server used. "Invalid email or
 * password" is deliberately vague about which half was wrong.
 */
export function LoginForm({ redirectTo }: { redirectTo: string }) {
  const [mode, setMode] = useState<Mode>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);

    if (mode === 'magic-link') {
      const result = await authClient.signIn.magicLink({ email, callbackURL: redirectTo });
      setPending(false);
      if (result.error) {
        setError('We could not send a sign-in link. Try again in a moment.');
        return;
      }
      setSent(true);
      return;
    }

    const result = await authClient.signIn.email({ email, password, callbackURL: redirectTo });
    setPending(false);

    if (result.error) {
      setError(
        result.error.status === 403
          ? 'Verify your email address before signing in. Check your inbox for the link.'
          : 'That email and password do not match an account.',
      );
      return;
    }

    window.location.assign(redirectTo);
  }

  if (sent) {
    return (
      <Alert tone="success">
        A sign-in link is on its way to {email}. It expires in ten minutes and works once.
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
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

      {mode === 'password' ? (
        <Field id="password" label="Password">
          {(aria) => (
            <Input
              {...aria}
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Signing in…' : mode === 'password' ? 'Sign in' : 'Email me a link'}
      </Button>

      <Button
        type="button"
        variant="tertiary"
        size="sm"
        onClick={() => {
          setMode(mode === 'password' ? 'magic-link' : 'password');
          setError(undefined);
        }}
      >
        {mode === 'password' ? 'Sign in with an email link instead' : 'Use a password instead'}
      </Button>
    </form>
  );
}
