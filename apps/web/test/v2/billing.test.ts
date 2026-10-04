import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  type BillingConfig,
  createCheckoutSession,
  STRIPE_TOLERANCE_SECONDS,
  verifyStripeSignature,
} from '@/lib/v2/billing/stripe';

/**
 * The optional Stripe module, without Stripe.
 *
 * Two things here can cost somebody money if they are wrong: a webhook that
 * accepts a body it should not, and a checkout session that names the wrong
 * organization or the wrong number of credits. Both are pure enough to pin
 * down exactly. The ledger write behind them is `recordCreditOnce`, which the
 * integration suite exercises against a real Postgres.
 */

const SECRET = 'whsec_test';
const NOW = 1_800_000_000;

function sign(payload: string, timestamp = NOW, secret = SECRET): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('verifyStripeSignature', () => {
  const payload = '{"type":"checkout.session.completed"}';

  it('accepts a body signed with the secret', () => {
    expect(verifyStripeSignature(payload, sign(payload), SECRET, NOW)).toBe(true);
  });

  it('refuses a body that was altered after signing', () => {
    expect(verifyStripeSignature(`${payload} `, sign(payload), SECRET, NOW)).toBe(false);
  });

  it('refuses a signature made with another secret', () => {
    expect(verifyStripeSignature(payload, sign(payload, NOW, 'whsec_other'), SECRET, NOW)).toBe(
      false,
    );
  });

  it('refuses a correctly signed body replayed outside the tolerance', () => {
    const old = NOW - STRIPE_TOLERANCE_SECONDS - 1;
    expect(verifyStripeSignature(payload, sign(payload, old), SECRET, NOW)).toBe(false);
  });

  it('accepts any one of several signatures, as during a secret rotation', () => {
    const header = `${sign(payload)},v1=${'0'.repeat(64)}`;
    expect(verifyStripeSignature(payload, header, SECRET, NOW)).toBe(true);
  });

  it('refuses a missing or malformed header', () => {
    for (const header of [null, '', 'v1=abc', 't=abc,v1=abc', `t=${NOW}`]) {
      expect(verifyStripeSignature(payload, header, SECRET, NOW), String(header)).toBe(false);
    }
  });
});

describe('createCheckoutSession', () => {
  const config: BillingConfig = {
    secretKey: 'sk_test_x',
    webhookSecret: SECRET,
    priceId: 'price_x',
    creditsPerUnit: 1000,
  };

  it('names the organization and the credits being bought in the session itself', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' })),
    );

    const session = await createCheckoutSession(
      { orgId: 'org_a', quantity: 3, successUrl: 'http://x/ok', cancelUrl: 'http://x/no' },
      config,
      fetchImpl as unknown as typeof fetch,
    );

    expect(session).toEqual({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    if (!init) throw new Error('Stripe was never called');
    expect(String(url)).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk_test_x');

    const form = init.body as URLSearchParams;
    expect(form.get('line_items[0][price]')).toBe('price_x');
    expect(form.get('line_items[0][quantity]')).toBe('3');
    expect(form.get('metadata[orgId]')).toBe('org_a');
    expect(form.get('metadata[credits]')).toBe('3000');
  });

  it('raises with Stripe`s own message when the session is refused', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: 'No such price' } }), { status: 400 });

    await expect(
      createCheckoutSession(
        { orgId: 'org_a', quantity: 1, successUrl: 'http://x/ok', cancelUrl: 'http://x/no' },
        config,
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow('No such price');
  });
});
