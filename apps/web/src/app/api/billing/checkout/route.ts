import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { loadWebEnv } from '@/lib/env';
import { BillingError, billingConfig, createCheckoutSession } from '@/lib/v2/billing/stripe';

/**
 * `POST /api/billing/checkout` — start a credit purchase.
 *
 * Owners only and closed to API keys: spending an organization's money is a
 * decision for a person who is signed in, not for whichever integration holds
 * a key. A 404 when billing is off, rather than a 403, because on a self-hosted
 * instance this endpoint does not exist in any sense that matters.
 */

const Body = z.object({ quantity: z.number().int().min(1).max(1000).default(1) });

export const POST = withAuth(
  async (request, auth) => {
    const env = loadWebEnv();
    const config = billingConfig(env);
    if (!config) {
      return Response.json(
        { error: { code: 'not_found', message: 'Billing is not enabled on this instance.' } },
        { status: 404 },
      );
    }

    const parsed = Body.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return Response.json(
        { error: { code: 'invalid_request', message: 'quantity must be between 1 and 1000.' } },
        { status: 400 },
      );
    }

    try {
      const session = await createCheckoutSession(
        {
          orgId: auth.orgId,
          quantity: parsed.data.quantity,
          successUrl: `${env.APP_URL}/settings/api-keys?purchase=complete`,
          cancelUrl: `${env.APP_URL}/settings/api-keys?purchase=cancelled`,
        },
        config,
      );
      return Response.json({ url: session.url }, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      console.error(
        '[billing] checkout failed',
        error instanceof BillingError ? error.message : error,
      );
      return Response.json(
        {
          error: { code: 'billing_unavailable', message: 'The payment page could not be opened.' },
        },
        { status: 502 },
      );
    }
  },
  { role: 'owner', allowApiKey: false },
);
