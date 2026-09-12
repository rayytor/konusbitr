'use client';

import { magicLinkClient, organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * The browser half of Better Auth.
 *
 * No `baseURL`: the client posts to the same origin it was served from, so a
 * self-hoster who puts Konusbitr behind a different hostname than `APP_URL`
 * still gets a working login page rather than a silent cross-origin failure.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient(), organizationClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
