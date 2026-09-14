'use client';

import { ScanLine, TriangleAlert } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { PageGeometry } from './geometry';

/**
 * Confidence at or above which a recognised page is reported without a warning.
 *
 * Mirrors `OCR_LOW_CONFIDENCE_THRESHOLD` on the worker. Duplicated rather than
 * plumbed through the API on purpose: this is the *presentation* boundary
 * between "worth mentioning" and "worth checking", and a viewer that had to
 * fetch a threshold before it could label a page would show an unlabelled page
 * first and relabel it a moment later.
 */
export const HIGH_CONFIDENCE = 0.85;

export type PageBadgeContent = {
  /** The short form, on the badge itself. */
  label: string;
  /** The whole claim, as a sentence, for the tooltip and for a screen reader. */
  sentence: string;
  /** Whether the reader is being asked to check the page rather than told a fact. */
  uncertain: boolean;
};

/**
 * What, if anything, to say about how a page was read.
 *
 * Split out from the component and exported so that the wording and the
 * threshold can be tested without a DOM. The rules are small and all three
 * matter:
 *
 * A **native** page gets nothing. Every other page in the product shows text its
 * author typed, so saying so on each one would be noise that trains a reader to
 * ignore the badge that does mean something.
 *
 * A **recognised** page says so, because a quoted sentence that came out of a
 * recogniser deserves different trust from one that came out of a font, and
 * nothing in the bounding boxes tells the two apart.
 *
 * A **low-confidence** page says what to do about it. "OCR 71%" is a number
 * without an action; a reader who is told to check the page has been given one.
 */
export function describePageTier(page: PageGeometry): PageBadgeContent | null {
  if (page.tier !== 'ocr') return null;

  const confidence = page.ocrConfidence;
  const known = confidence !== null && confidence !== undefined;
  const percent = known ? Math.round(confidence * 100) : null;
  const uncertain = known && confidence < HIGH_CONFIDENCE;

  return {
    label: percent === null ? 'OCR' : `OCR ${percent}%`,
    sentence: uncertain
      ? `Page ${page.page} was read by text recognition with ${percent}% confidence. ` +
        'Check the page itself before relying on a quote from it.'
      : `Page ${page.page} was read by text recognition${
          percent === null ? '' : ` with ${percent}% confidence`
        }.`,
    uncertain,
  };
}

/**
 * A marker on a page whose text came out of a recogniser rather than a font.
 *
 * This is an honesty control, not a decoration. `design.md` §24 forbids
 * communicating state by colour alone, so the meaning is carried by an icon and
 * a word and the colour only reinforces it.
 *
 * Nothing here animates on hover. The badge sits in the gutter above the page
 * rather than on it — a marker drawn over the paper would cover the one thing a
 * reader opened the page to check. The visible text is `aria-hidden` and the
 * whole sentence is exposed to a screen reader instead, because "OCR 71%" read
 * aloud is not a sentence.
 */
export function PageBadge({ page, className }: { page: PageGeometry; className?: string }) {
  const content = describePageTier(page);
  if (!content) return null;

  const Icon = content.uncertain ? TriangleAlert : ScanLine;

  return (
    <Tooltip label={content.sentence}>
      <span
        data-page-tier="ocr"
        data-confidence={content.uncertain ? 'low' : 'high'}
        className={cn(
          'inline-flex select-none items-center gap-1.5 rounded-full border px-2 py-0.5',
          'font-sans text-[11px] leading-none tracking-[0.01em]',
          content.uncertain
            ? 'border-warning/40 text-warning'
            : 'border-border-subtle text-foreground-subtle',
          className,
        )}
      >
        <Icon aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
        <span aria-hidden>{content.label}</span>
        {content.uncertain ? <span aria-hidden>— verify text</span> : null}
        <span className="sr-only">{content.sentence}</span>
      </span>
    </Tooltip>
  );
}
