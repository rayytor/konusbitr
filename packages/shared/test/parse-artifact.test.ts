import { describe, expect, it } from 'vitest';
import { ExtractedImageSchema } from '../src/parse-artifact.js';

/**
 * The parse artifact's `images` array crosses from Python to TypeScript through
 * a `jsonb` column rather than through a message, so nothing generates anything
 * and the two halves mirror each other. This file holds the literal JSON they
 * agree on — the same arrangement, and for the same reason, as `chunk.test.ts`.
 *
 * `services/worker/tests/test_figure_fixtures.py` asserts the Python side
 * produces exactly this.
 */
describe('ExtractedImageSchema', () => {
  it('accepts what the worker writes for a captioned figure', () => {
    const parsed = ExtractedImageSchema.parse({
      id: 'img_001',
      page: 4,
      bbox: [72, 268, 468, 532],
      width: 792,
      height: 528,
      storageKey: 'orgs/org_abc123/documents/doc_xyz789/images/1.png',
      caption:
        'A bar chart of revenue by region. North America accounts for 54 percent of the total.',
    });

    expect(parsed.caption).toContain('54 percent');
    expect(parsed.bbox).toEqual([72, 268, 468, 532]);
  });

  it('accepts an uncaptioned figure, which is the default state', () => {
    // No vision model configured, or an upload that did not ask for `llm`. The
    // figure is still extracted, stored and locatable; it is simply not
    // searchable. `null` rather than an absent key, because pydantic serialises
    // an unset optional as JSON `null` and `undefined` has no JSON spelling.
    const parsed = ExtractedImageSchema.parse({
      id: 'img_002',
      page: 1,
      bbox: [72, 100, 300, 240],
      width: 400,
      height: 240,
      storageKey: 'orgs/org_abc123/documents/doc_xyz789/images/2.png',
      caption: null,
    });

    expect(parsed.caption).toBeNull();
  });

  it('refuses a figure that cannot say where it came from', () => {
    // The load-bearing rule, restated for images: a figure with no page cannot
    // be cited, and an uncitable answer is the failure this product exists to
    // prevent.
    const result = ExtractedImageSchema.safeParse({
      id: 'img_003',
      page: 0,
      bbox: [72, 100, 300, 240],
      width: 400,
      height: 240,
      storageKey: 'orgs/org_abc123/documents/doc_xyz789/images/3.png',
      caption: null,
    });

    expect(result.success).toBe(false);
  });
});
