import { loadWebEnv } from '@/lib/env';
import { applyStripeEvent, billingConfig, verifyStripeSignature } from '@/lib/v2/billing/stripe';

/**
 * `POST /api/billing/webhook` — Stripe telling us a purchase was paid.
 *
 * Unauthenticated by design and listed as such in
 * `test/auth/protected-routes.test.ts`: the caller is Stripe, which has no
 * session and no API key. What stands in for a principal is the signature —
 * nothing is parsed, and nothing is written, until the raw body has been
 * verified against `STRIPE_WEBHOOK_SECRET`.
 */
export async function POST(request: Request): Promise<Response> {
  const config = billingConfig(loadWebEnv());
  if (!config) return new Response(null, { status: 404 });

  // Text, not JSON: the signature is over the bytes as sent, and a parse and
  // re-serialise would not reproduce them.
  const payload = await request.text();
  if (
    !verifyStripeSignature(payload, request.headers.get('stripe-signature'), config.webhookSecret)
  ) {
    return new Response(null, { status: 400 });
  }

  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response(null, { status: 400 });
  }

  const outcome = await applyStripeEvent(event as Parameters<typeof applyStripeEvent>[0]);
  return Response.json({ received: true, applied: outcome.applied });
}

export const dynamic = 'force-dynamic';
