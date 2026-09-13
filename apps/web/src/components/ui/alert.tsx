import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A short, calm message about what just happened.
 *
 * Every tone carries an icon as well as a colour, because `design.md` forbids
 * communicating state by colour alone — and an error that reads as ordinary
 * text to a colour-blind reader is exactly the failure that rule exists to
 * prevent. Errors announce themselves politely to assistive technology.
 */
const TONES = {
  info: { icon: Info, className: 'text-foreground-muted', role: 'status' },
  success: { icon: CheckCircle2, className: 'text-success', role: 'status' },
  error: { icon: AlertTriangle, className: 'text-danger', role: 'alert' },
} as const;

export function Alert({
  tone = 'info',
  children,
  className,
}: {
  tone?: keyof typeof TONES;
  children: ReactNode;
  className?: string;
}) {
  const { icon: Icon, className: toneClass, role } = TONES[tone];
  return (
    <p
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
      className={cn('flex items-start gap-2 text-[15px] leading-relaxed', toneClass, className)}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
