import { describe, expect, it } from 'vitest';
import { generateApiKey } from '@/lib/auth/api-key';
import { REDACTED, redact, redactString } from '@/lib/auth/redact';

/**
 * The acceptance criterion is blunt: never log a raw key, a password or a
 * session token. This is the test that makes it enforceable, so it errs
 * towards over-covering rather than under.
 */
describe('redact', () => {
  it('removes a password whatever it looks like', () => {
    const logged = redact({ email: 'a@b.test', password: 'correct horse battery staple' });
    expect(logged).toEqual({ email: 'a@b.test', password: REDACTED });
  });

  it('removes every secret-shaped field name', () => {
    const logged = redact({
      newPassword: 'x',
      apiKey: 'x',
      api_key: 'x',
      hashedKey: 'x',
      accessToken: 'x',
      refreshToken: 'x',
      idToken: 'x',
      sessionToken: 'x',
      authorization: 'x',
      cookie: 'x',
      secret: 'x',
      token: 'x',
    }) as Record<string, unknown>;

    for (const value of Object.values(logged)) expect(value).toBe(REDACTED);
  });

  it('removes a raw API key from inside free text', () => {
    const { token } = generateApiKey();
    const line = `request failed with key ${token} on /v2/parse`;

    expect(redactString(line)).not.toContain(token);
    expect(redactString(line)).toContain(REDACTED);
  });

  it('removes an Authorization credential from inside free text', () => {
    const redacted = redactString('sent Bearer eyJhbGciOi.J9.abc to upstream');
    expect(redacted).not.toContain('eyJhbGciOi');
    expect(redacted).toContain(`Bearer ${REDACTED}`);
  });

  it('reaches secrets nested in objects and arrays', () => {
    const { token } = generateApiKey();
    const logged = redact({
      request: { headers: { cookie: 'session=abc' }, body: { password: 'hunter2' } },
      attempts: [{ token }, { note: `used ${token}` }],
    });

    expect(JSON.stringify(logged)).not.toContain(token);
    expect(JSON.stringify(logged)).not.toContain('hunter2');
    expect(JSON.stringify(logged)).not.toContain('session=abc');
  });

  it('redacts an error message without losing the error', () => {
    const { token } = generateApiKey();
    const logged = redact(new Error(`bad key ${token}`)) as { name: string; message: string };

    expect(logged.name).toBe('Error');
    expect(logged.message).not.toContain(token);
  });

  it('survives a cycle instead of throwing', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;

    expect(redact(node)).toEqual({ name: 'root', self: '[circular]' });
  });

  it('leaves ordinary values alone', () => {
    expect(redact({ page: 3, ok: true, title: 'Quarterly report', missing: null })).toEqual({
      page: 3,
      ok: true,
      title: 'Quarterly report',
      missing: null,
    });
  });
});
