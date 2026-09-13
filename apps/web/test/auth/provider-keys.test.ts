import { describe, expect, it } from 'vitest';
import {
  decryptProviderKey,
  encryptProviderKey,
  getProviderKeyRecords,
  listProviderKeyViews,
  maskApiKey,
  removeProviderKeyRecord,
  resolveProviderKeySecret,
  upsertProviderKeyRecord,
} from '@/lib/auth/provider-keys';

describe('provider-keys encryption and decryption', () => {
  const secret = 'konusbitr-development-secret-test-key-123';
  const apiKey = 'sk-proj-test1234567890abcdef987654321';

  it('round-trips an encrypted key back to original plaintext', () => {
    const encrypted = encryptProviderKey(apiKey, secret);
    expect(encrypted).not.toBe(apiKey);
    expect(encrypted.split(':')).toHaveLength(3);

    const decrypted = decryptProviderKey(encrypted, secret);
    expect(decrypted).toBe(apiKey);
  });

  it('fails decryption with wrong secret', () => {
    const encrypted = encryptProviderKey(apiKey, secret);
    const decrypted = decryptProviderKey(encrypted, 'wrong-secret-string');
    expect(decrypted).toBeNull();
  });

  it('returns null on corrupted payload', () => {
    expect(decryptProviderKey('corrupted-data', secret)).toBeNull();
    expect(decryptProviderKey('a:b:c', secret)).toBeNull();
  });
});

describe('maskApiKey', () => {
  it('masks OpenAI style keys while keeping prefix and suffix', () => {
    const masked = maskApiKey('sk-proj-1234567890abcdef1234567890abcdef');
    expect(masked.startsWith('sk-proj-')).toBe(true);
    expect(masked.endsWith('cdef')).toBe(true);
    expect(masked).toContain('••••••••••••••••');
    expect(masked).not.toContain('1234567890abcdef');
  });

  it('masks Anthropic style keys', () => {
    const masked = maskApiKey('sk-ant-api03-abcdef12345678901234');
    expect(masked.startsWith('sk-ant-')).toBe(true);
    expect(masked.endsWith('1234')).toBe(true);
  });

  it('masks Google Gemini style keys', () => {
    const masked = maskApiKey('AIzaSyAbc1234567890DefGhIjKlMnOpQrStUv');
    expect(masked.startsWith('AIzaSy')).toBe(true);
    expect(masked.endsWith('StUv')).toBe(true);
  });

  it('masks short keys cleanly', () => {
    expect(maskApiKey('12345')).toBe('••••••••');
  });
});

describe('organization settings provider key operations', () => {
  const secret = 'test-auth-secret';

  it('upserts a new provider key record into empty settings', () => {
    const { updatedSettings, view } = upsertProviderKeyRecord(null, {
      provider: 'openai',
      key: 'sk-proj-12345678901234567890',
      label: 'OpenAI Prod',
      authSecret: secret,
    });

    expect(view.provider).toBe('openai');
    expect(view.label).toBe('OpenAI Prod');
    expect(view.maskedKey).toContain('••••');
    expect(view.id.startsWith('pkey_openai_')).toBe(true);

    const records = getProviderKeyRecords(updatedSettings);
    expect(records).toHaveLength(1);
    expect(records[0]?.encryptedKey).toBeDefined();

    // Verify secret can be resolved
    const resolved = resolveProviderKeySecret(updatedSettings, 'openai', secret);
    expect(resolved).toBe('sk-proj-12345678901234567890');
  });

  it('updates an existing provider key without duplicating', () => {
    const first = upsertProviderKeyRecord(
      {},
      {
        provider: 'openai',
        key: 'sk-proj-first-key-1234567890',
        label: 'First Key',
        authSecret: secret,
      },
    );

    const second = upsertProviderKeyRecord(first.updatedSettings, {
      provider: 'openai',
      key: 'sk-proj-updated-key-0987654321',
      label: 'Updated Key',
      authSecret: secret,
    });

    const records = getProviderKeyRecords(second.updatedSettings);
    expect(records).toHaveLength(1);
    expect(second.view.label).toBe('Updated Key');
    expect(second.view.createdAt).toBe(first.view.createdAt);

    const resolved = resolveProviderKeySecret(second.updatedSettings, 'openai', secret);
    expect(resolved).toBe('sk-proj-updated-key-0987654321');
  });

  it('lists provider key views without exposing secrets', () => {
    const { updatedSettings } = upsertProviderKeyRecord(
      {},
      {
        provider: 'anthropic',
        key: 'sk-ant-12345678901234567890',
        label: 'Claude Key',
        authSecret: secret,
      },
    );

    const views = listProviderKeyViews(updatedSettings);
    expect(views).toHaveLength(1);
    expect(views[0]?.provider).toBe('anthropic');
    expect(views[0]?.label).toBe('Claude Key');
    expect(views[0] ? 'encryptedKey' in views[0] : false).toBe(false);
  });

  it('removes a provider key record', () => {
    const { updatedSettings: s1 } = upsertProviderKeyRecord(
      {},
      {
        provider: 'openai',
        key: 'sk-proj-test-1234567890',
        authSecret: secret,
      },
    );

    const { updatedSettings: s2, removed } = removeProviderKeyRecord(s1, 'openai');
    expect(removed).toBe(true);
    expect(getProviderKeyRecords(s2)).toHaveLength(0);

    const secondAttempt = removeProviderKeyRecord(s2, 'openai');
    expect(secondAttempt.removed).toBe(false);
  });
});
