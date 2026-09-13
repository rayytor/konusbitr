'use client';

import { Copy, Cpu, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import type { ProviderKeyView } from '@/lib/auth/provider-keys';
import { API_SCOPES, type ApiScope } from '@/lib/auth/scopes';
import { ProviderKeysPanel } from './provider-keys-panel';

export type ApiKeyView = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type ApiKeysPanelProps = {
  initialKeys?: ApiKeyView[];
  initialKonusbitrKeys?: ApiKeyView[];
  initialProviderKeys?: ProviderKeyView[];
};

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

type TabType = 'konusbitr' | 'providers';

/**
 * Manage Konusbitr API keys and Model Provider API keys.
 *
 * Distinct categories:
 * - Konusbitr API keys authenticate external scripts and apps calling the Konusbitr API.
 * - Model provider keys connect external AI providers (OpenAI, Anthropic, etc.) for chat and extraction.
 */
export function ApiKeysPanel({
  initialKeys,
  initialKonusbitrKeys,
  initialProviderKeys = [],
}: ApiKeysPanelProps) {
  const [activeTab, setActiveTab] = useState<TabType>('konusbitr');
  const [keys, setKeys] = useState<ApiKeyView[]>(initialKonusbitrKeys ?? initialKeys ?? []);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['documents:read']);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);

    const response = await fetch('/api/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, scopes }),
    });

    setPending(false);

    if (!response.ok) {
      setError('We could not create that key. Check the name and try again.');
      return;
    }

    const body = (await response.json()) as { key: ApiKeyView; token: string };
    setKeys([body.key, ...keys]);
    setCreated({ token: body.token, name: body.key.name });
    setCopied(false);
    setName('');
  }

  async function revoke(key: ApiKeyView) {
    const confirmed = window.confirm(
      `Revoke "${key.name}"? Anything using it stops working immediately, and it cannot be restored.`,
    );
    if (!confirmed) return;

    const response = await fetch(`/api/api-keys/${key.id}`, { method: 'DELETE' });
    if (!response.ok) {
      setError('We could not revoke that key. Reload the page and try again.');
      return;
    }

    setKeys(
      keys.map((row) =>
        row.id === key.id ? { ...row, revokedAt: new Date().toISOString() } : row,
      ),
    );
  }

  const tabOptions = [
    { value: 'konusbitr' as const, label: 'Konusbitr API keys', icon: KeyRound },
    { value: 'providers' as const, label: 'Model provider keys', icon: Cpu },
  ];

  return (
    <div className="flex flex-col gap-8">
      {/* Category selector */}
      <div>
        <Segmented
          label="API key category"
          value={activeTab}
          onChange={setActiveTab}
          options={tabOptions}
        />
      </div>

      {activeTab === 'providers' ? (
        <ProviderKeysPanel initialKeys={initialProviderKeys} />
      ) : (
        <div className="flex flex-col gap-10">
          <div className="rounded-[var(--radius-md)] border border-border-subtle bg-surface p-4">
            <h3 className="font-serif text-[17px] leading-tight text-foreground">
              Konusbitr API Keys
            </h3>
            <p className="mt-1 text-[14px] leading-relaxed text-foreground-muted">
              Keys authenticate requests to the Konusbitr REST API. Each one carries the scopes you
              give it and nothing more. Use these in external automations, scripts, or SDKs.
            </p>
          </div>

          {created ? (
            <section className="rounded-[var(--radius-md)] border border-accent-muted bg-surface p-4">
              <h2 className="font-serif text-[18px] leading-tight">Copy your key now</h2>
              <p className="mt-1 text-[15px] leading-relaxed text-foreground-muted">
                This is the only time “{created.name}” is shown in full. Konusbitr stores a hash of
                it, so it cannot be shown again — if you lose it, create another.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-[var(--radius-sm)] bg-surface-muted px-3 py-2 font-mono text-[13px]">
                  {created.token}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(created.token).then(() => setCopied(true));
                  }}
                >
                  <Copy aria-hidden />
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <Button
                className="mt-3"
                type="button"
                variant="tertiary"
                size="sm"
                onClick={() => setCreated(null)}
              >
                I have saved it
              </Button>
            </section>
          ) : null}

          <form onSubmit={create} className="flex flex-col gap-5">
            <h2 className="font-serif text-[24px] leading-tight">Create a key</h2>

            <Field
              id="key-name"
              label="Name"
              hint="What this key is for — “CI pipeline”, “Zapier”."
            >
              {(aria) => (
                <Input
                  {...aria}
                  required
                  maxLength={80}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </Field>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-[15px] text-foreground-muted">Scopes</legend>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {API_SCOPES.map((scope) => (
                  <label key={scope} className="flex cursor-pointer items-center gap-2 text-[15px]">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--accent)]"
                      checked={scopes.includes(scope)}
                      onChange={(event) =>
                        setScopes(
                          event.target.checked
                            ? [...scopes, scope]
                            : scopes.filter((value) => value !== scope),
                        )
                      }
                    />
                    <span className="font-mono text-[13px]">{scope}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {error ? <Alert tone="error">{error}</Alert> : null}

            <div>
              <Button type="submit" disabled={pending || scopes.length === 0 || name.trim() === ''}>
                {pending ? 'Creating…' : 'Create key'}
              </Button>
            </div>
          </form>

          <section className="flex flex-col gap-4">
            <h2 className="font-serif text-[24px] leading-tight">Keys</h2>

            {keys.length === 0 ? (
              <div className="flex items-start gap-3 text-[15px] text-foreground-muted">
                <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0" />
                <p>No keys yet. Create one above to call the Konusbitr API.</p>
              </div>
            ) : (
              <ul className="flex flex-col divide-y divide-border-subtle">
                {keys.map((key) => (
                  <li key={key.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-[15px]">
                        <span className="truncate">{key.name}</span>
                        {key.revokedAt ? (
                          <span className="shrink-0 rounded-[var(--radius-sm)] bg-surface-muted px-1.5 py-0.5 text-[13px] text-foreground-muted">
                            Revoked
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-1 font-mono text-[13px] text-foreground-subtle">
                        {key.prefix}…
                      </p>
                    </div>

                    <dl className="flex gap-6 text-[13px] text-foreground-muted">
                      <div>
                        <dt className="text-foreground-subtle">Last used</dt>
                        <dd>{formatDate(key.lastUsedAt)}</dd>
                      </div>
                      <div>
                        <dt className="text-foreground-subtle">Created</dt>
                        <dd>{formatDate(key.createdAt)}</dd>
                      </div>
                    </dl>

                    {key.revokedAt ? null : (
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={() => void revoke(key)}
                      >
                        Revoke
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
