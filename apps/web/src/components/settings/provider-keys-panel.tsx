'use client';

import { SUPPORTED_EXTERNAL_PROVIDERS } from '@konusbitr/shared';
import { Cpu, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import type { ProviderKeyView } from '@/lib/auth/provider-keys';

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const DEFAULT_PROVIDER_META = {
  id: 'openai',
  name: 'OpenAI',
  placeholder: 'sk-proj-...',
  requiresKey: true,
};

export function ProviderKeysPanel({ initialKeys }: { initialKeys: ProviderKeyView[] }) {
  const [keys, setKeys] = useState<ProviderKeyView[]>(initialKeys);
  const [selectedProvider, setSelectedProvider] = useState<string>('openai');
  const [label, setLabel] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [baseUrl, setBaseUrl] = useState<string>('');
  const [showKey, setShowKey] = useState<boolean>(false);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);

  const activeProviderMeta =
    SUPPORTED_EXTERNAL_PROVIDERS.find((p) => p.id === selectedProvider) ??
    SUPPORTED_EXTERNAL_PROVIDERS[0] ??
    DEFAULT_PROVIDER_META;

  function handleSelectProvider(providerId: string) {
    setSelectedProvider(providerId);
    setError(null);
    setSuccess(null);
    const existing = keys.find((k) => k.provider === providerId);
    if (existing) {
      setLabel(existing.label);
      setBaseUrl(existing.baseUrl ?? '');
      setEditingKeyId(existing.id);
    } else {
      const meta = SUPPORTED_EXTERNAL_PROVIDERS.find((p) => p.id === providerId);
      setLabel(meta?.name ? `${meta.name} Key` : '');
      setBaseUrl(meta?.defaultBaseUrl ?? '');
      setEditingKeyId(null);
    }
  }

  function startEdit(key: ProviderKeyView) {
    setSelectedProvider(key.provider);
    setLabel(key.label);
    setBaseUrl(key.baseUrl ?? '');
    setApiKey('');
    setEditingKeyId(key.id);
    setError(null);
    setSuccess(null);
  }

  function cancelEdit() {
    setEditingKeyId(null);
    setApiKey('');
    setLabel('');
    setBaseUrl('');
    setError(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!apiKey.trim()) {
      setError('Please enter an API key.');
      return;
    }

    setPending(true);
    setError(null);
    setSuccess(null);

    const providerName =
      SUPPORTED_EXTERNAL_PROVIDERS.find((p) => p.id === selectedProvider)?.name ?? selectedProvider;

    const response = await fetch('/api/provider-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: editingKeyId ?? undefined,
        provider: selectedProvider,
        key: apiKey.trim(),
        label: label.trim() || `${providerName} Key`,
        baseUrl: baseUrl.trim() || undefined,
      }),
    });

    setPending(false);

    if (!response.ok) {
      const res = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(res?.error?.message ?? 'Failed to save provider key. Please check the values.');
      return;
    }

    const body = (await response.json()) as { key: ProviderKeyView };
    const saved = body.key;

    setKeys((current) => {
      const idx = current.findIndex((k) => k.id === saved.id || k.provider === saved.provider);
      if (idx >= 0) {
        return current.map((k, i) => (i === idx ? saved : k));
      }
      return [saved, ...current];
    });

    setSuccess(`Successfully saved ${providerName} API key.`);
    setApiKey('');
    setEditingKeyId(null);
  }

  async function handleDelete(key: ProviderKeyView) {
    const confirmed = window.confirm(
      `Remove the API key for ${key.label || key.provider}? Outbound requests using this provider will fail until reconfigured.`,
    );
    if (!confirmed) return;

    setError(null);
    setSuccess(null);

    const response = await fetch(`/api/provider-keys/${key.id}`, { method: 'DELETE' });
    if (!response.ok) {
      setError('Could not remove this provider key. Please try again.');
      return;
    }

    setKeys((current) => current.filter((k) => k.id !== key.id));
    if (editingKeyId === key.id) {
      cancelEdit();
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <div className="rounded-[var(--radius-md)] border border-border-subtle bg-surface p-4">
        <h3 className="font-serif text-[17px] leading-tight text-foreground">
          Model Provider Keys (BYOK)
        </h3>
        <p className="mt-1 text-[14px] leading-relaxed text-foreground-muted">
          Add API keys for AI model providers like OpenAI, Anthropic, and Google Gemini to power
          chat and document extraction for this workspace. Keys are encrypted at rest with AES-256
          and never revealed in plaintext after submission.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-[24px] leading-tight">
            {editingKeyId ? 'Update provider key' : 'Add a provider key'}
          </h2>
          {editingKeyId ? (
            <Button type="button" variant="tertiary" size="sm" onClick={cancelEdit}>
              Cancel edit
            </Button>
          ) : null}
        </div>

        {/* Quick provider selector */}
        <div className="flex flex-col gap-2">
          <span className="text-[15px] text-foreground-muted">Provider</span>
          <div className="flex flex-wrap gap-2">
            {SUPPORTED_EXTERNAL_PROVIDERS.map((provider) => {
              const isConfigured = keys.some((k) => k.provider === provider.id);
              const isSelected = selectedProvider === provider.id;

              return (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => handleSelectProvider(provider.id)}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-[14px] ${
                    isSelected
                      ? 'border-accent bg-surface text-foreground shadow-xs'
                      : 'border-border-subtle bg-surface-muted text-foreground-muted hover:border-border hover:text-foreground'
                  }`}
                >
                  <span>{provider.name}</span>
                  {isConfigured ? (
                    <span className="flex size-2 rounded-full bg-success" title="Configured" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <Field
          id="provider-label"
          label="Label"
          hint="A friendly name for this key, e.g. “Team OpenAI” or “Anthropic Production”."
        >
          {(aria) => (
            <Input
              {...aria}
              value={label}
              maxLength={80}
              placeholder={`${activeProviderMeta.name} Key`}
              onChange={(e) => setLabel(e.target.value)}
            />
          )}
        </Field>

        <Field
          id="provider-api-key"
          label="API key"
          hint={
            editingKeyId
              ? 'Enter a new secret to replace the existing key.'
              : `Your ${activeProviderMeta.name} API secret key.`
          }
        >
          {(aria) => (
            <div className="relative flex items-center">
              <Input
                {...aria}
                required
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                placeholder={activeProviderMeta.placeholder}
                className="pr-10 font-mono text-[14px]"
                onChange={(e) => setApiKey(e.target.value)}
              />
              <button
                type="button"
                aria-label={showKey ? 'Hide key' : 'Show key'}
                className="absolute right-2.5 cursor-pointer text-foreground-subtle hover:text-foreground"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          )}
        </Field>

        {selectedProvider === 'custom' ||
        selectedProvider === 'openai' ||
        selectedProvider === 'ollama' ? (
          <Field
            id="provider-base-url"
            label="Base URL (optional)"
            hint="Custom endpoint origin, e.g. for LiteLLM proxy, Azure OpenAI, or Ollama."
          >
            {(aria) => (
              <Input
                {...aria}
                type="url"
                value={baseUrl}
                placeholder="https://api.openai.com/v1"
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            )}
          </Field>
        ) : null}

        {error ? <Alert tone="error">{error}</Alert> : null}
        {success ? <Alert tone="success">{success}</Alert> : null}

        <div>
          <Button type="submit" disabled={pending || apiKey.trim() === ''}>
            {pending ? 'Saving…' : editingKeyId ? 'Update key' : 'Save key'}
          </Button>
        </div>
      </form>

      <section className="flex flex-col gap-4">
        <h2 className="font-serif text-[24px] leading-tight">Configured provider keys</h2>

        {keys.length === 0 ? (
          <div className="flex items-start gap-3 text-[15px] text-foreground-muted">
            <Cpu aria-hidden className="mt-0.5 size-4 shrink-0" />
            <p>
              No provider API keys configured yet. Select a provider above and enter your key to
              enable custom model access for this workspace.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {keys.map((key) => {
              const meta = SUPPORTED_EXTERNAL_PROVIDERS.find((p) => p.id === key.provider);
              const displayName = meta?.name ?? key.provider;

              return (
                <li key={key.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[15px]">
                      <span className="font-medium text-foreground">
                        {key.label || displayName}
                      </span>
                      <span className="rounded-[var(--radius-sm)] bg-surface-muted px-2 py-0.5 font-mono text-[12px] text-foreground-muted">
                        {displayName}
                      </span>
                    </p>
                    <p className="mt-1 font-mono text-[13px] text-foreground-subtle">
                      {key.maskedKey}
                    </p>
                    {key.baseUrl ? (
                      <p className="mt-0.5 font-mono text-[12px] text-foreground-subtle">
                        Base URL: {key.baseUrl}
                      </p>
                    ) : null}
                  </div>

                  <dl className="flex gap-6 text-[13px] text-foreground-muted">
                    <div>
                      <dt className="text-foreground-subtle">Updated</dt>
                      <dd>{formatDate(key.updatedAt)}</dd>
                    </div>
                  </dl>

                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => startEdit(key)}
                    >
                      <Pencil aria-hidden />
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() => void handleDelete(key)}
                    >
                      <Trash2 aria-hidden />
                      Remove
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
