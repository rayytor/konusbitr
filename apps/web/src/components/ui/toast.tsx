'use client';

import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '@/lib/utils';

export type ToastTone = 'info' | 'success' | 'error';

type Toast = {
  id: number;
  tone: ToastTone;
  message: string;
  /** One optional action, because a toast with two is a dialog in disguise. */
  action?: { label: string; onClick: () => void };
};

type ToastContextValue = {
  toast: (message: string, options?: { tone?: ToastTone; action?: Toast['action'] }) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TONES = {
  info: { icon: Info, className: 'text-foreground-muted' },
  success: { icon: CheckCircle2, className: 'text-success' },
  error: { icon: AlertTriangle, className: 'text-danger' },
} as const;

/** Long enough to read a sentence; errors stay until dismissed. */
const DISMISS_AFTER_MS = 5000;

/**
 * Transient confirmations for mutations that would otherwise be silent.
 *
 * `design.md` asks for a toast on every mutation, and §24's rule about colour
 * applies here too: each tone carries an icon, so "deleted" and "could not
 * delete" are distinguishable without seeing the difference between green and
 * red.
 *
 * The region is `aria-live="polite"` and, critically, is rendered on the page
 * from the start rather than being created when the first toast appears — a
 * live region inserted at the same moment as its content is not announced by
 * most screen readers.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const toast = useCallback<ToastContextValue['toast']>((message, options) => {
    const id = nextId.current++;
    const tone = options?.tone ?? 'info';
    setToasts((current) => [
      ...current,
      { id, tone, message, ...(options?.action ? { action: options.action } : {}) },
    ]);

    if (tone !== 'error') {
      setTimeout(
        () => setToasts((current) => current.filter((e) => e.id !== id)),
        DISMISS_AFTER_MS,
      );
    }
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4"
      >
        {toasts.map((entry) => {
          const { icon: Icon, className } = TONES[entry.tone];
          return (
            <div
              key={entry.id}
              className={cn(
                'kb-fade-in pointer-events-auto flex w-full max-w-md items-start gap-2.5',
                'rounded-[var(--radius-md)] border border-border-subtle bg-surface px-4 py-3 shadow-lg',
              )}
            >
              <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', className)} />
              <p className="flex-1 text-[15px] leading-relaxed">{entry.message}</p>
              {entry.action ? (
                <button
                  type="button"
                  onClick={() => {
                    dismiss(entry.id);
                    entry.action?.onClick();
                  }}
                  className="cursor-pointer text-[15px] text-accent-contrast underline underline-offset-2"
                >
                  {entry.action.label}
                </button>
              ) : null}
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => dismiss(entry.id)}
                className="cursor-pointer text-foreground-subtle hover:text-foreground"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Toasting from a component that may not be under a provider.
 *
 * Returns a no-op rather than throwing, because a missing toast is a missing
 * confirmation and a thrown error is a blank page. The provider wraps the app
 * shell, so in practice this is always present.
 */
export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  return value ?? { toast: () => undefined };
}

/** Announce a one-off message politely without rendering anything visible. */
export function useAnnounce(): (message: string) => void {
  const [, setTick] = useState(0);
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = document.createElement('p');
    node.setAttribute('aria-live', 'polite');
    node.className = 'sr-only';
    document.body.append(node);
    ref.current = node;
    setTick((n) => n + 1);
    return () => node.remove();
  }, []);

  return useCallback((message: string) => {
    if (ref.current) ref.current.textContent = message;
  }, []);
}
