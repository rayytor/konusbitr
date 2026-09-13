import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openWorkspace, uploadAndWait } from './fixtures';

/**
 * The rest of the acceptance criteria: dark mode, 375px, keyboard navigation,
 * accessibility, and a viewer that keeps a bounded number of pages alive.
 *
 * These are separated from the citation smoke test because they are checks on
 * the surface rather than on the product's one interaction — a failure here is
 * a regression in the workspace, not a broken pipeline, and the two want
 * different debugging.
 */

const FIXTURE = 'text-50p.pdf';

test.describe('the workspace', () => {
  test.beforeEach(async ({ page }) => {
    await uploadAndWait(page, FIXTURE);
    await openWorkspace(page, FIXTURE);
    await expect(page.locator('[data-page-number="1"] canvas')).toBeVisible({ timeout: 45_000 });
  });

  test('renders a bounded window of pages however far it is scrolled', async ({ page }) => {
    const scroller = page.getByRole('region', { name: /text-50p\.pdf, 50 pages/ });

    // The full document's height exists from the first frame, because page
    // geometry comes from the database rather than from PDF.js.
    const scrollHeight = await scroller.evaluate((node) => node.scrollHeight);
    expect(scrollHeight).toBeGreaterThan(20_000);

    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      await scroller.evaluate(
        (node, at) => node.scrollTo({ top: node.scrollHeight * at }),
        fraction,
      );
      await page.waitForTimeout(400);
      // One visible page, one either side, and nothing else: a viewer that
      // keeps fifty canvases alive is the one that stutters.
      expect(await page.locator('[data-page-number]').count()).toBeLessThanOrEqual(6);
    }

    await expect(page.locator('[data-page-number="50"]')).toBeVisible();
  });

  test('jumps to a page typed into the toolbar', async ({ page }) => {
    await page.getByLabel('Page number').fill('37');
    await page.getByLabel('Page number').press('Enter');
    await expect(page.locator('[data-page-number="37"]')).toBeVisible({ timeout: 15_000 });
  });

  test('opens the command palette with the keyboard and focuses the composer', async ({ page }) => {
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('combobox', { name: 'Search commands' });
    await expect(palette).toBeFocused();

    await palette.fill('ask');
    await palette.press('Enter');

    await expect(
      page.getByRole('textbox', { name: 'Ask a question about this document' }),
    ).toBeFocused();
  });

  test('the split divider is movable from the keyboard', async ({ page }) => {
    const divider = page.getByRole('separator', { name: /Resize the document and chat panes/ });
    const before = await divider.getAttribute('aria-valuenow');

    await divider.focus();
    await divider.press('ArrowLeft');
    await divider.press('ArrowLeft');

    expect(await divider.getAttribute('aria-valuenow')).not.toBe(before);
  });

  test('has no critical accessibility violations', async ({ page }) => {
    const results = await new AxeBuilder({ page })
      // The PDF canvas is an image of a document; axe's colour-contrast rule
      // samples its pixels and reports the document's own typography, which is
      // not ours to fix and not what this assertion is for.
      .exclude('[data-page-number]')
      .analyze();

    const serious = results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );
    expect(
      serious,
      serious.map((violation) => `${violation.id}: ${violation.help}`).join('\n'),
    ).toEqual([]);
  });
});

test.describe('responsive and themed', () => {
  test('collapses to tabs at 375px and a citation switches to the document', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await uploadAndWait(page, FIXTURE);
    await openWorkspace(page, FIXTURE);

    const chatTab = page.getByRole('tab', { name: 'Chat' });
    const documentTab = page.getByRole('tab', { name: 'Document' });
    await expect(chatTab).toBeVisible();
    await expect(chatTab).toHaveAttribute('aria-selected', 'true');

    await documentTab.click();
    await expect(documentTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-page-number="1"] canvas')).toBeVisible({ timeout: 45_000 });

    // Nothing may scroll the page sideways at 375px.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('dark mode dims the page rather than inverting it', async ({ page }) => {
    await uploadAndWait(page, FIXTURE);
    await openWorkspace(page, FIXTURE);

    await page.getByRole('radio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    const filter = await page
      .locator('[data-page-number="1"] canvas')
      .evaluate((node) => getComputedStyle(node).filter);

    // Brightness and a trace of warmth. An `invert()` here would mean a scan
    // rendered as a photographic negative, which is unreadable.
    expect(filter).toContain('brightness');
    expect(filter).not.toContain('invert');

    // And it survives a reload, applied before first paint.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('the library', () => {
  // A different fixture from the workspace tests above, because this one ends
  // by deleting what it uploaded and the suite shares one organization.
  const LIBRARY_FIXTURE = 'tables-financial.pdf';

  test('has no critical accessibility violations', async ({ page }) => {
    await uploadAndWait(page, LIBRARY_FIXTURE);

    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );
    expect(
      serious,
      serious.map((violation) => `${violation.id}: ${violation.help}`).join('\n'),
    ).toEqual([]);
  });

  test('renames, filters and deletes', async ({ page }) => {
    await uploadAndWait(page, LIBRARY_FIXTURE);

    const setInputValue = async (locator: ReturnType<typeof page.getByLabel>, value: string) => {
      await locator.evaluate((el: HTMLInputElement, val) => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )?.set;
        setter?.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
    };

    await page
      .getByRole('button', { name: `Actions for ${LIBRARY_FIXTURE}` })
      .dispatchEvent('click');
    await page.getByRole('menuitem', { name: 'Rename' }).dispatchEvent('click');
    await setInputValue(page.getByLabel('Document name'), 'Renamed fixture.pdf');
    await page.getByRole('button', { name: 'Rename' }).dispatchEvent('click');

    await expect(page.getByRole('link', { name: 'Renamed fixture.pdf' }).first()).toBeVisible();

    await setInputValue(page.getByLabel('Filter documents by name'), 'nothing matches this');
    await expect(page.getByText('No document matches that filter.')).toBeVisible();
    await setInputValue(page.getByLabel('Filter documents by name'), '');

    await page
      .getByRole('button', { name: 'Actions for Renamed fixture.pdf' })
      .dispatchEvent('click');
    await page.getByRole('menuitem', { name: 'Delete' }).dispatchEvent('click');
    await page.getByRole('button', { name: 'Delete' }).dispatchEvent('click');

    await expect(page.getByRole('link', { name: 'Renamed fixture.pdf' })).toHaveCount(0);
  });
});
