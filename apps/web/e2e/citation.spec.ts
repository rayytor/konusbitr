import type { Citation } from '@konusbitr/shared';
import { expect, test } from '@playwright/test';
import { openWorkspace, uploadAndWait } from './fixtures';

/**
 * The product's smoke test.
 *
 * Sign up → upload → wait for ready → ask → an answer streams → click the
 * citation → **the viewer scrolls to the cited page and draws a rectangle
 * within two pixels of where the bounding box says it belongs.**
 *
 * That last assertion is the one worth having, and it is the reason this test
 * is not a screenshot comparison. A highlight in roughly the right place looks
 * fine in a screenshot and is a lie: it means the coordinate convention has
 * drifted somewhere between `parse/geometry.py` and `viewer/geometry.ts`, and
 * the next document it is wrong on will be wrong by a page rather than by a
 * line. Comparing against the stored bounding box catches the drift on the
 * first document.
 */

const FIXTURE = 'text-50p.pdf';

/** How far a drawn highlight may sit from its bounding box, in CSS pixels. */
const TOLERANCE_PX = 2;

test.describe('citation click-through', () => {
  test('an answer cites a page, and clicking it highlights the passage', async ({ page }) => {
    await uploadAndWait(page, FIXTURE);
    const documentId = await openWorkspace(page, FIXTURE);

    // ── The document opens ───────────────────────────────────────────────────

    await expect(page.locator('[data-page-number="1"] canvas')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('of 50', { exact: true })).toBeVisible();

    // ── Ask ──────────────────────────────────────────────────────────────────

    const composer = page.getByRole('textbox', {
      name: 'Ask a question about this document',
    });
    await composer.fill('What convention are bounding boxes stored in?');
    await composer.press('Enter');

    // The stage indicator is the promise that retrieval is happening; it has to
    // appear before any token does.
    await expect(page.getByText('Searching the document…')).toBeVisible({ timeout: 20_000 });

    const chip = page.getByRole('button', { name: /Show page \d+ in the document/ }).first();
    await expect(chip).toBeVisible({ timeout: 60_000 });

    // ── What the server actually verified ────────────────────────────────────

    const citation = await readFirstCitation(page, documentId);
    expect(citation, 'the answer produced at least one verified citation').toBeTruthy();
    if (!citation) return;

    // ── Click it ─────────────────────────────────────────────────────────────

    await chip.click();

    const pageElement = page.locator(`[data-page-number="${citation.page}"]`);
    await expect(pageElement).toBeVisible({ timeout: 30_000 });

    const highlight = pageElement.locator('[data-citation-id][data-active="true"]');
    await expect(highlight).toBeVisible({ timeout: 15_000 });

    // ── And check where it landed ────────────────────────────────────────────

    await page.waitForFunction((selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const y = el.getBoundingClientRect().y;
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(Math.abs(el.getBoundingClientRect().y - y) < 1);
        }, 150);
      });
    }, `[data-page-number="${citation.page}"]`);

    const geometry = await readPageGeometry(page, documentId, citation.page);
    const pageBox = await pageElement.boundingBox();
    const highlightBox = await highlight.boundingBox();
    expect(pageBox).not.toBeNull();
    expect(highlightBox).not.toBeNull();
    if (!pageBox || !highlightBox) return;

    // `docs/coordinates.md`: the viewer applies a scale factor and nothing else.
    const scale = pageBox.width / geometry.width;
    const [x0, y0, x1, y1] = citation.bbox;

    expect(highlightBox.x - pageBox.x).toBeCloseTo(x0 * scale, -Math.log10(TOLERANCE_PX));
    expect(highlightBox.y - pageBox.y).toBeCloseTo(y0 * scale, -Math.log10(TOLERANCE_PX));
    expect(Math.abs(highlightBox.width - (x1 - x0) * scale)).toBeLessThanOrEqual(TOLERANCE_PX);
    expect(Math.abs(highlightBox.height - (y1 - y0) * scale)).toBeLessThanOrEqual(TOLERANCE_PX);

    // The cited page is not merely mounted — it is on screen.
    const viewport = page.viewportSize();
    expect(pageBox.y).toBeLessThan((viewport?.height ?? 900) + 1);
    expect(pageBox.y + pageBox.height).toBeGreaterThan(0);

    // ── Escape clears it, which is the documented shortcut ───────────────────

    await page.keyboard.press('Escape');
    await expect(pageElement.locator('[data-citation-id]')).toHaveCount(0);
  });

  test('a question the document cannot answer is refused rather than invented', async ({
    page,
  }) => {
    await uploadAndWait(page, FIXTURE);
    await openWorkspace(page, FIXTURE);

    const composer = page.getByRole('textbox', {
      name: 'Ask a question about this document',
    });
    // A query with no lexical overlap retrieves nothing, so the context is
    // empty and the stub — like a real model under this prompt — refuses.
    await composer.fill('zzqqxx vlorptin hgfdsaqw');
    await composer.press('Enter');

    const refusal = page.getByRole('listitem').filter({ hasText: /cannot find the answer/i });
    await expect(refusal).toBeVisible({ timeout: 60_000 });
    await expect(refusal.getByRole('button', { name: /Show page \d+/ })).toHaveCount(0);
  });
});

async function readFirstCitation(
  page: import('@playwright/test').Page,
  documentId: string,
): Promise<Citation | null> {
  const payload = await page.evaluate(async (id: string) => {
    const list = await fetch(`/api/conversations?documentId=${id}`).then((r) => r.json());
    const conversation = list.conversations?.[0];
    if (!conversation) return null;
    const detail = await fetch(`/api/conversations/${conversation.id}`).then((r) => r.json());
    const assistant = [...(detail.messages ?? [])]
      .reverse()
      .find((message: { role: string }) => message.role === 'assistant');
    return assistant?.citations?.[0] ?? null;
  }, documentId);

  return payload as Citation | null;
}

async function readPageGeometry(
  page: import('@playwright/test').Page,
  documentId: string,
  pageNumber: number,
): Promise<{ width: number; height: number }> {
  const geometry = await page.evaluate(
    async ({ id, pageNumber: wanted }: { id: string; pageNumber: number }) => {
      const payload = await fetch(`/api/documents/${id}/pages`).then((r) => r.json());
      return payload.pages.find((row: { page: number }) => row.page === wanted) ?? null;
    },
    { id: documentId, pageNumber },
  );

  if (!geometry) throw new Error(`no page row for page ${pageNumber}`);
  return geometry as { width: number; height: number };
}
