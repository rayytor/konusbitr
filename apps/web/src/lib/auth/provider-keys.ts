import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Model Provider API keys (e.g. OpenAI, Anthropic, Google Gemini).
 *
 * Distinct from Konusbitr API keys:
 * - Konusbitr API keys authenticate external clients to Konusbitr (inbound).
 *   They are hashed with SHA-256 and never recoverable.
 * - Provider API keys are credentials Konusbitr uses to call external LLMs (outbound).
 *   They are symmetrically encrypted at rest with AES-256-GCM using AUTH_SECRET,
 *   stored in organizations.settings.providerKeys, and decrypted only when making
 *   outbound model requests.
 */

export type ProviderKeyRecord = {
  id: string;
  provider: string;
  label: string;
  maskedKey: string;
  encryptedKey: string; // format: `${ivHex}:${tagHex}:${dataHex}`
  baseUrl?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProviderKeyView = {
  id: string;
  provider: string;
  label: string;
  maskedKey: string;
  baseUrl?: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Derive a 256-bit encryption key from AUTH_SECRET.
 */
function deriveKey(authSecret: string): Buffer {
  return createHash('sha256').update(authSecret, 'utf8').digest();
}

/**
 * Encrypt a secret using AES-256-GCM.
 */
export function encryptProviderKey(secret: string, authSecret: string): string {
  const key = deriveKey(authSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt an AES-256-GCM encrypted provider key.
 */
export function decryptProviderKey(encryptedPayload: string, authSecret: string): string | null {
  try {
    const parts = encryptedPayload.split(':');
    if (parts.length !== 3) return null;
    const [ivHex, tagHex, dataHex] = parts;
    if (!ivHex || !tagHex || !dataHex) return null;

    const key = deriveKey(authSecret);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Produce a safe preview string for display in the UI without exposing the full secret.
 * Preserves recognized prefix conventions (e.g. sk-proj-, sk-ant-, gsk_) and the last 4 characters.
 */
export function maskApiKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 8) {
    return '••••••••';
  }

  const match = /^(sk-[a-zA-Z0-9_-]+-|sk-|gsk_|AIzaSy)/.exec(trimmed);
  const prefix = match ? match[0] : trimmed.slice(0, 4);
  const suffix = trimmed.slice(-4);
  return `${prefix}••••••••••••••••${suffix}`;
}

export function presentProviderKey(record: ProviderKeyRecord): ProviderKeyView {
  return {
    id: record.id,
    provider: record.provider,
    label: record.label,
    maskedKey: record.maskedKey,
    baseUrl: record.baseUrl ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Read the list of provider key records from organization settings.
 */
export function getProviderKeyRecords(
  settings: Record<string, unknown> | null | undefined,
): ProviderKeyRecord[] {
  if (!settings || typeof settings !== 'object') return [];
  const list = settings.providerKeys;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item): item is ProviderKeyRecord =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as ProviderKeyRecord).id === 'string' &&
      typeof (item as ProviderKeyRecord).provider === 'string' &&
      typeof (item as ProviderKeyRecord).encryptedKey === 'string',
  );
}

/**
 * Read the public views of provider keys for the client.
 */
export function listProviderKeyViews(
  settings: Record<string, unknown> | null | undefined,
): ProviderKeyView[] {
  return getProviderKeyRecords(settings).map(presentProviderKey);
}

/**
 * Add or update a provider key in the organization settings JSONB.
 */
export function upsertProviderKeyRecord(
  settings: Record<string, unknown> | null | undefined,
  input: {
    id?: string;
    provider: string;
    key: string;
    label?: string;
    baseUrl?: string | null;
    authSecret: string;
  },
): { updatedSettings: Record<string, unknown>; view: ProviderKeyView } {
  const existing = getProviderKeyRecords(settings);
  const now = new Date().toISOString();
  const provider = input.provider.trim().toLowerCase();
  const id = input.id ?? `pkey_${provider}_${randomBytes(6).toString('hex')}`;
  const label = input.label?.trim() || `${provider.toUpperCase()} Key`;
  const maskedKey = maskApiKey(input.key);
  const encryptedKey = encryptProviderKey(input.key.trim(), input.authSecret);
  const baseUrl = input.baseUrl?.trim() || null;

  const existingIndex = existing.findIndex((k) => k.id === id || k.provider === provider);

  const newRecord: ProviderKeyRecord = {
    id,
    provider,
    label,
    maskedKey,
    encryptedKey,
    baseUrl,
    createdAt: (existingIndex >= 0 ? existing[existingIndex]?.createdAt : undefined) ?? now,
    updatedAt: now,
  };

  const updatedRecords =
    existingIndex >= 0
      ? existing.map((r, i) => (i === existingIndex ? newRecord : r))
      : [newRecord, ...existing];

  const updatedSettings: Record<string, unknown> = {
    ...(settings ?? {}),
    providerKeys: updatedRecords,
  };

  return {
    updatedSettings,
    view: presentProviderKey(newRecord),
  };
}

/**
 * Remove a provider key from organization settings by ID or provider name.
 */
export function removeProviderKeyRecord(
  settings: Record<string, unknown> | null | undefined,
  idOrProvider: string,
): { updatedSettings: Record<string, unknown>; removed: boolean } {
  const existing = getProviderKeyRecords(settings);
  const filtered = existing.filter(
    (k) => k.id !== idOrProvider && k.provider.toLowerCase() !== idOrProvider.toLowerCase(),
  );

  const removed = filtered.length < existing.length;
  const updatedSettings: Record<string, unknown> = {
    ...(settings ?? {}),
    providerKeys: filtered,
  };

  return { updatedSettings, removed };
}

/**
 * Decrypt the active key for a given provider, if configured for this organization.
 */
export function resolveProviderKeySecret(
  settings: Record<string, unknown> | null | undefined,
  provider: string,
  authSecret: string,
): string | null {
  const existing = getProviderKeyRecords(settings);
  const target = existing.find((k) => k.provider.toLowerCase() === provider.toLowerCase());
  if (!target) return null;
  return decryptProviderKey(target.encryptedKey, authSecret);
}
