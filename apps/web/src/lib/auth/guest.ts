import { randomBytes } from 'node:crypto';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { BetterAuthPlugin } from 'better-auth/types';

/** Determine whether an email represents a temporary guest account. */
export function isGuestEmail(email?: string | null): boolean {
  if (!email) return false;
  return email.startsWith('guest-') && email.endsWith('@konusbitr.local');
}

/**
 * Better Auth plugin providing guest authentication.
 *
 * Exposes `POST /api/auth/sign-in/guest`, which generates an instant guest user
 * and personal workspace without requiring email confirmation or password entry.
 */
export function guestPlugin(): BetterAuthPlugin {
  return {
    id: 'guest',
    endpoints: {
      signInGuest: createAuthEndpoint(
        '/sign-in/guest',
        {
          method: 'POST',
          disableBody: true,
        },
        async (ctx) => {
          const suffix = randomBytes(4).toString('hex');
          const email = `guest-${suffix}@konusbitr.local`;
          const name = 'Guest';

          const newUser = await ctx.context.internalAdapter.createUser(
            {
              email,
              emailVerified: true,
              name,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            { method: 'anonymous' },
          );

          if (!newUser) {
            throw new Error('Failed to create guest user');
          }

          const session = await ctx.context.internalAdapter.createSession(newUser.id);
          if (!session) {
            throw new Error('Failed to create guest session');
          }

          await setSessionCookie(ctx, { session, user: newUser });

          return ctx.json({
            ok: true,
            user: newUser,
            session,
          });
        },
      ),
    },
  };
}
