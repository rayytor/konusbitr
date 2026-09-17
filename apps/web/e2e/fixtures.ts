import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

export const FIXTURE_DIR = join(ROOT, 'fixtures', 'pdf');

/** Where `auth.setup.ts` leaves the signed-in session for every other test. */
export const STORAGE_STATE = join(HERE, '.auth', 'user.json');

/**
 * Upload a fixture through the library and wait for it to be readable.
 *
 * Through the real file input, so the browser really does PUT the bytes
 * straight to object storage over a presigned URL — which is also what proves
 * `S3_PUBLIC_ENDPOINT` is right, a thing that is invisible until a browser
 * tries it.
 *
 * Idempotent by construction: the docId cache is keyed on the file's bytes, so
 * a second upload of the same fixture resolves to the same document in
 * milliseconds without a job. That is why the tests below can share one
 * account without each paying for a parse.
 */
export async function uploadAndWait(page: Page, filename: string): Promise<void> {
  await page.goto('/documents');

  const filePath = join(FIXTURE_DIR, filename);
  const buffer = readFileSync(filePath);
  const base64 = buffer.toString('base64');

  await page.locator('input[type="file"]').waitFor({ state: 'attached' });

  await page.evaluate(
    ({ b64, name }) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], name, { type: 'application/pdf' });

      const input = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error('File input not found');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { b64: base64, name: filename },
  );

  const row = page.getByRole('link', { name: filename, exact: true }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });

  // The status word inside *this* document's row, not a colour and not any
  // row's: the library renders "Ready" beside an icon, and the SSE stream from
  // `/api/documents/:id/events` is what moves it there.
  //
  // `exact`, because Phase 12.4 added a second badge whose label begins with
  // the same word: a long document reads "Ready to read" while it is still
  // being indexed. A substring match would settle for that and then ask a
  // question of a document that is not finished — which is a supported thing
  // to do and not what this test is waiting for.
  const container = row.locator('xpath=ancestor::*[@data-document-id][1]');
  await expect(container.getByText('Ready', { exact: true })).toBeVisible({
    timeout: 180_000,
  });
}

/** Open a document's workspace from the library. */
export async function openWorkspace(page: Page, filename: string): Promise<string> {
  const link = page.getByRole('link', { name: filename, exact: true }).first();
  const href = await link.getAttribute('href');
  if (href) {
    await page.goto(href);
  } else {
    await link.click();
  }
  await page.waitForURL(/\/documents\/doc_/, { timeout: 30_000 });

  const id = new URL(page.url()).pathname.split('/').pop();
  if (!id) throw new Error('could not read the document id out of the workspace URL');
  return id;
}
