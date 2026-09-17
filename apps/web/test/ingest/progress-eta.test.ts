import { describe, expect, it } from 'vitest';
import { formatEta } from '@/lib/use-document-progress';

/**
 * How a wait is worded.
 *
 * The estimate itself is a rolling average of an observed rate and is tested
 * through the hook; what is checked here is the rendering, which is the half a
 * reader actually sees. It is deliberately coarse: a countdown to the second
 * invites somebody to watch it and notice every time it is wrong, and the
 * number behind it is an average of a rate that genuinely changes when a
 * filing switches from born-digital pages to photocopies.
 */
describe('formatEta', () => {
  it('does not put a number on a wait that is nearly over', () => {
    expect(formatEta(5)).toBe('less than a minute');
    expect(formatEta(44)).toBe('less than a minute');
  });

  it('rounds to whole minutes, and says "about"', () => {
    expect(formatEta(60)).toBe('about 1 minute');
    expect(formatEta(240)).toBe('about 4 minutes');
  });

  it('switches to hours rather than reading out 63 minutes', () => {
    expect(formatEta(3600)).toBe('about 1 hour');
    expect(formatEta(7800)).toBe('about 2 hours');
  });
});
