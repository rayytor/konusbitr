import { createHmac, timingSafeEqual } from 'node:crypto';
import { scopedDb } from '@konusbitr/db';
import type { Env } from '@konusbitr/shared';
import { db } from '@/lib/db';

/**
 * The optional Stripe module: buying credits, and nothing else.
 *
 * Off unless `BILLING_ENABLED=true`, and removable — delete this directory and
 * `src/app/api/billing/` and the stack still builds, because nothing outside
 * those two imports from here. Konusbitr is a product somebody can run for
 * themselves; a payment processor must not be load-bearing for that.
 *
 * It speaks to Stripe over `fetch` rather than through Stripe's SDK, and that
 * is the same decision made the same way: two form-encoded requests and one
 * HMAC do not justify a dependency in a build whose default configuration
 * never executes them.
 *
 * What it does is deliberately narrow. A checkout session sells a quantity of
 * one price; Stripe calls back when it is paid; the callback becomes a `topup`
 * row in the same ledger every charge is written to. There is no customer
 * record, no subscription and no balance held anywhere but the ledger — so
 * "why does this organization have 5,000 credits" has the same answer a charge
 * has: a row, with a reason and a reference.
 */

const STRIPE_API = 'https://api.stripe.com/v1';

/** How far a webhook's timestamp may be from now before it is a replay. */
export const STRIPE_TOLERANCE_SECONDS = 300;

export type BillingConfig = {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
  /** Credits granted per unit of the price bought. */
  creditsPerUnit: number;
};

/** The module's configuration, or `null` when billing is switched off. */
export function billingConfig(env: Env): BillingConfig | null {
  if (!env.BILLING_ENABLED) return null;
  // Boot validation has already refused `BILLING_ENABLED=true` without these,
  // so this is a narrowing rather than a second check.
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_PRICE_ID) return null;

  return {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    priceId: env.STRIPE_PRICE_ID,
    creditsPerUnit: env.STRIPE_CREDITS_PER_UNIT,
  };
}

export class BillingError extends Error {}

/**
 * Open a Stripe Checkout session for `quantity` units of the configured price.
 *
 * The organization and the credits it is buying travel in the session's own
 * metadata, and come back in the webhook under Stripe's signature. Nothing
 * about a purchase is remembered here in between — which is what lets the
 * webhook be handled by a different process, or the same one after a restart.
 */
export async function createCheckoutSession(
  input: { orgId: string; quantity: number; successUrl: string; cancelUrl: string },
  config: BillingConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; url: string }> {
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price]': config.priceId,
    'line_items[0][quantity]': String(input.quantity),
    client_reference_id: input.orgId,
    'metadata[orgId]': input.orgId,
    'metadata[credits]': String(input.quantity * config.creditsPerUnit),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });

  const response = await fetchImpl(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const body = (await response.json().catch(() => null)) as {
    id?: string;
    url?: string;
    error?: { message?: string };
  } | null;

  if (!response.ok || !body?.id || !body.url) {
    throw new BillingError(body?.error?.message ?? `Stripe answered ${response.status}.`);
  }
  return { id: body.id, url: body.url };
}

/**
 * Check a `Stripe-Signature` header against the raw request body.
 *
 * The header is `t=<unix seconds>,v1=<hex>[,v1=<hex>…]` and the signed string
 * is `${t}.${body}` — the *bytes received*, which is why the route reads text
 * and never parses before calling this. Several `v1` values appear while a
 * signing secret is being rolled, and any one matching is a pass.
 */
export function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;

  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't') timestamp = value;
    if (key === 'v1' && value) signatures.push(value);
  }

  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > STRIPE_TOLERANCE_SECONDS) return false;

  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex'),
  );

  return signatures.some((signature) => {
    const presented = Buffer.from(signature);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  });
}

type CheckoutCompleted = {
  type?: string;
  data?: {
    object?: {
      id?: string;
      payment_status?: string;
      metadata?: { orgId?: string; credits?: string };
    };
  };
};

export type AppliedEvent =
  | { applied: true; orgId: string; credits: number }
  | { applied: false; reason: 'ignored' | 'unpaid' | 'malformed' | 'duplicate' };

/**
 * Turn a verified event into a ledger row, at most once.
 *
 * Only `checkout.session.completed` with `payment_status: "paid"` grants
 * anything; every other event is acknowledged and ignored, because Stripe
 * retries whatever is not answered with a 2xx and an endpoint that rejected
 * events it does not care about would be retried at for days.
 *
 * The session id is the ledger reference, and `recordCreditOnce` is what makes
 * a redelivery harmless: Stripe delivers at least once, and a customer who paid
 * once must not be credited twice because an acknowledgement was slow.
 */
export async function applyStripeEvent(event: CheckoutCompleted): Promise<AppliedEvent> {
  if (event.type !== 'checkout.session.completed') return { applied: false, reason: 'ignored' };

  const session = event.data?.object;
  if (session?.payment_status !== 'paid') return { applied: false, reason: 'unpaid' };

  const orgId = session.metadata?.orgId;
  const credits = Number(session.metadata?.credits);
  if (!session.id || !orgId || !Number.isInteger(credits) || credits <= 0) {
    return { applied: false, reason: 'malformed' };
  }

  const written = await scopedDb(db(), orgId).recordCreditOnce({
    delta: credits,
    reason: 'topup',
    refId: session.id,
    metadata: { source: 'stripe' },
  });

  return written ? { applied: true, orgId, credits } : { applied: false, reason: 'duplicate' };
}
