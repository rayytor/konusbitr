import { describe, expect, it } from 'vitest';
import type { PageGeometry } from '@/components/viewer/geometry';
import { describePageTier, HIGH_CONFIDENCE } from '@/components/viewer/page-badge';

function page(overrides: Partial<PageGeometry> = {}): PageGeometry {
  return { page: 4, width: 612, height: 792, ...overrides };
}

describe('describePageTier', () => {
  it('says nothing about a born-digital page', () => {
    // Every other page in the product shows text its author typed. Saying so on
    // each one is noise that trains a reader to ignore the badge that means
    // something.
    expect(describePageTier(page({ tier: 'native' }))).toBeNull();
    expect(describePageTier(page())).toBeNull();
  });

  it('reports a confidently recognised page without asking for anything', () => {
    const content = describePageTier(page({ tier: 'ocr', ocrConfidence: 0.92 }));

    expect(content).not.toBeNull();
    expect(content?.label).toBe('OCR 92%');
    expect(content?.uncertain).toBe(false);
    expect(content?.sentence).toContain('Page 4 was read by text recognition');
  });

  it('asks the reader to check a low-confidence page', () => {
    // "OCR 71%" is a number without an action. A reader told to check the page
    // has been given one, which is the whole difference between a warning and a
    // decoration.
    const content = describePageTier(page({ tier: 'ocr', ocrConfidence: 0.71 }));

    expect(content?.label).toBe('OCR 71%');
    expect(content?.uncertain).toBe(true);
    expect(content?.sentence).toContain('Check the page itself');
  });

  it('treats the threshold itself as confident', () => {
    expect(describePageTier(page({ tier: 'ocr', ocrConfidence: HIGH_CONFIDENCE }))?.uncertain).toBe(
      false,
    );
    expect(
      describePageTier(page({ tier: 'ocr', ocrConfidence: HIGH_CONFIDENCE - 0.001 }))?.uncertain,
    ).toBe(true);
  });

  it('still marks a recognised page whose confidence was not recorded', () => {
    // A parse from before confidences were stored. The page was still read by a
    // recogniser, and that is the part a reader needs — claiming a number we do
    // not have would be worse than omitting it.
    const content = describePageTier(page({ tier: 'ocr', ocrConfidence: null }));

    expect(content?.label).toBe('OCR');
    expect(content?.uncertain).toBe(false);
    expect(content?.sentence).not.toContain('%');
  });

  it('names the page it is talking about', () => {
    // The badge is read aloud on its own, out of the visual context that would
    // otherwise say which page it belongs to.
    expect(
      describePageTier(page({ page: 118, tier: 'ocr', ocrConfidence: 0.5 }))?.sentence,
    ).toContain('Page 118');
  });
});
