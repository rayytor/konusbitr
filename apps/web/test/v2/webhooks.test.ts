import { createHmac } from 'node:crypto';
import {
  formatWebhookSignature,
  parseWebhookSignature,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  webhookSigningPayload,
} from '@konusbitr/shared';
import { describe, expect, it, vi } from 'vitest';

/**
 * The webhook signature, verified with something other than the signer.
 *
 * `verifyWebhook` and `signWebhook` share a module, so a test that signed with
 * one and checked with the other would pass even if both were wrong in the same
 * way. The digests below are therefore computed here, from the documented
 * signing payload, exactly as a receiver's own code would compute them.
 */

const SECRET = 'a-test-signing-secret';

/** What a receiver written from the documentation does. */
function digestOf(body: string, timestamp: number, secret = SECRET): string {
  return createHmac('sha256', secret).update(webhookSigningPayload(timestamp, body)).digest('hex');
}

async function loadWebhooks() {
  vi.resetModules();
  vi.doMock('@/lib/env', () => ({
    loadWebEnv: () => ({ WEBHOOK_SIGNING_SECRET: SECRET, AUTH_SECRET: 'unused' }),
  }));
  return import('@/lib/v2/webhooks');
}

describe('the signing payload', () => {
  it('is `{timestamp}.{body}`', () => {
    expect(webhookSigningPayload(1700000000, '{"a":1}')).toBe('1700000000.{"a":1}');
  });

  it('round-trips a versioned signature header', () => {
    const digest = 'a'.repeat(64);
    expect(parseWebhookSignature(formatWebhookSignature(digest))).toBe(digest);
  });

  it('refuses a header that is not a v1 hex digest', () => {
    expect(parseWebhookSignature(null)).toBeNull();
    expect(parseWebhookSignature('')).toBeNull();
    expect(parseWebhookSignature(`v2=${'a'.repeat(64)}`)).toBeNull();
    expect(parseWebhookSignature('v1=nothex')).toBeNull();
    expect(parseWebhookSignature(`v1=${'a'.repeat(63)}`)).toBeNull();
  });
});

describe('signWebhook', () => {
  it('produces the digest a receiver computes from the documentation', async () => {
    const { signWebhook } = await loadWebhooks();
    const body = '{"jobId":"ajob_1","status":"succeeded"}';
    const timestamp = 1_700_000_000;
    expect(signWebhook(body, timestamp)).toBe(`v1=${digestOf(body, timestamp)}`);
  });

  it('signs the timestamp into the payload, not merely alongside it', async () => {
    const { signWebhook } = await loadWebhooks();
    const body = '{"a":1}';
    // Without this property, a captured delivery could be replayed with any
    // timestamp the attacker liked, which defeats the point of having one.
    expect(signWebhook(body, 1_700_000_000)).not.toBe(signWebhook(body, 1_700_000_001));
  });
});

describe('verifyWebhook', () => {
  const body = '{"jobId":"ajob_1"}';
  const now = 1_700_000_000;

  it('accepts a correctly signed, fresh delivery', async () => {
    const { verifyWebhook } = await loadWebhooks();
    expect(
      verifyWebhook(
        body,
        { signature: `v1=${digestOf(body, now)}`, timestamp: String(now) },
        { nowSeconds: now },
      ),
    ).toBe(true);
  });

  it('rejects a body that was altered after signing', async () => {
    const { verifyWebhook } = await loadWebhooks();
    expect(
      verifyWebhook(
        '{"jobId":"ajob_2"}',
        { signature: `v1=${digestOf(body, now)}`, timestamp: String(now) },
        { nowSeconds: now },
      ),
    ).toBe(false);
  });

  it('rejects a signature made with a different secret', async () => {
    const { verifyWebhook } = await loadWebhooks();
    expect(
      verifyWebhook(
        body,
        { signature: `v1=${digestOf(body, now, 'someone-elses-secret')}`, timestamp: String(now) },
        { nowSeconds: now },
      ),
    ).toBe(false);
  });

  it('rejects a replay outside the freshness window', async () => {
    const { verifyWebhook } = await loadWebhooks();
    const stale = now - WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 1;
    expect(
      verifyWebhook(
        body,
        { signature: `v1=${digestOf(body, stale)}`, timestamp: String(stale) },
        { nowSeconds: now },
      ),
    ).toBe(false);
  });

  it('accepts a delivery at the edge of the window, in both directions', async () => {
    const { verifyWebhook } = await loadWebhooks();
    for (const skew of [
      -WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
      WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
    ]) {
      const timestamp = now + skew;
      expect(
        verifyWebhook(
          body,
          { signature: `v1=${digestOf(body, timestamp)}`, timestamp: String(timestamp) },
          { nowSeconds: now },
        ),
      ).toBe(true);
    }
  });

  it('rejects a missing or nonsense timestamp', async () => {
    const { verifyWebhook } = await loadWebhooks();
    expect(verifyWebhook(body, { signature: `v1=${digestOf(body, now)}`, timestamp: null })).toBe(
      false,
    );
    expect(verifyWebhook(body, { signature: `v1=${digestOf(body, now)}`, timestamp: 'soon' })).toBe(
      false,
    );
  });

  it('rejects a missing signature', async () => {
    const { verifyWebhook } = await loadWebhooks();
    expect(verifyWebhook(body, { signature: null, timestamp: String(now) })).toBe(false);
  });
});
