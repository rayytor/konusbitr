'use client';

import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * PDF.js, loaded once, in the browser, on demand.
 *
 * Three things are deliberate here.
 *
 * **It is a dynamic import.** `pdfjs-dist` reaches for `DOMMatrix`, `Path2D`
 * and a worker at module scope; importing it from a file Next.js also renders
 * on the server turns a page into a 500. Nothing above this module imports
 * PDF.js statically.
 *
 * **The worker is a real `Worker`, constructed from a bundled URL.** Parsing
 * and rasterising a 500-page document on the main thread is the whole reason
 * "renders without jank" would fail; `new URL(..., import.meta.url)` is what
 * makes the bundler emit the worker chunk as its own asset.
 *
 * **It is a classic worker, deliberately — not `{ type: 'module' }`.** The
 * source is `pdf.worker.mjs`, so a module worker is the obvious guess, and it
 * is wrong: webpack does not inline the worker, it emits a small bootstrap that
 * pulls the 1.2MB body in with `importScripts()`, and `importScripts` does not
 * exist in a module worker. Asking for one gets "Module scripts don't support
 * importScripts()" thrown inside the worker before PDF.js runs a line, which
 * surfaces as every document failing to display. The bundler output is its own
 * format either way, so the `.mjs` source extension does not decide this.
 *
 * **The worker is per-load, and it is not `GlobalWorkerOptions.workerPort`.**
 * That global is the tempting shape — boot one worker, reuse it for every
 * document — and it is actively unsafe, because PDF.js keys a `PDFWorker` by
 * port and `PDFDocumentLoadingTask.destroy()` destroys the task's worker. One
 * shared port therefore means the *first* cancelled load terminates the worker
 * for the whole page and deletes it from the port cache, and every load after
 * it fails with "PDFWorker.create - the worker is being destroyed" — for as
 * long as the tab is open, because the global still points at the corpse.
 * Cancelled loads are routine (`<Viewer>` aborts on unmount, and the workspace
 * remounts it once the viewport media query resolves), so the shared port does
 * not degrade under load: it fails every time, on the first render. A worker
 * per load costs a few milliseconds and gives the task something it is allowed
 * to destroy.
 *
 * **cMaps, standard fonts and the WASM decoders are served from our own
 * origin**, copied into `public/pdfjs` by `scripts/copy-pdfjs-assets.mjs`. The
 * usual advice is to point these at a CDN. A self-hostable, privacy-first
 * document tool that phones out to a CDN the first time someone opens a CJK
 * PDF is not self-hosted, and on an air-gapped instance it is simply broken.
 */

const ASSET_BASE = '/pdfjs';

type PdfModule = typeof import('pdfjs-dist');

let modulePromise: Promise<PdfModule> | undefined;

export async function loadPdfjs(): Promise<PdfModule> {
  modulePromise ??= import('pdfjs-dist');
  return modulePromise;
}

/** A fresh worker thread for one loading task. See the note above on why. */
function spawnWorkerPort(): Worker {
  return new Worker(new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url), {
    name: 'konusbitr-pdf',
  });
}

export type LoadedPdf = {
  document: PDFDocumentProxy;
  /** Cancels the in-flight load, if it has not finished. */
  destroy: () => void;
};

export type OpenPdfOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: { loaded: number; total: number }) => void;
};

/**
 * Open a PDF from a presigned URL.
 *
 * Ranged loading is what makes large (100MB+) documents open in about the time
 * it takes to fetch the first page: PDF.js asks storage for byte ranges rather
 * than buffering the entire file into browser worker memory. MinIO, S3, R2 and
 * B2 all serve `Range`, so this is the behaviour everywhere rather than an
 * optimization for one backend.
 *
 * **`disableAutoFetch` is deliberately *not* set, and that is load-bearing.**
 * It reads as the natural companion to ranged loading — fetch only the bytes a
 * page actually needs — and on an image-heavy document it is catastrophic.
 * Auto-fetch is what pulls the rest of the file in the background *while the
 * reader looks at page one*; without it, every image `page.render()` reaches
 * for is a cold range request, served one at a time, with the render task
 * stalled in between. Measured on the 173MB/240-page fixture, rasterising page
 * one:
 *
 * | options                                      | `page.render()` |
 * | -------------------------------------------- | --------------- |
 * | defaults                                     | 137ms           |
 * | `disableStream` only                         | 180ms           |
 * | `disableAutoFetch` only                      | 25,620ms        |
 * | both, `rangeChunkSize: 1MB`                  | 59,501ms        |
 *
 * Worker-side parse time is identical in every row (~70ms), so the cost is
 * round trips during rasterisation rather than bytes — which is also why a
 * larger `rangeChunkSize` makes it worse rather than better. The viewer renders
 * a window of pages at once, so that is a minute or more of a pegged tab on
 * open: long enough that Chrome's renderer watchdog fires and kills the tab
 * with `FATAL:child_thread_impl.cc "Crashing because hung"`, which reaches the
 * reader as an "Aw, Snap!" page reporting `SIGILL`.
 *
 * This removes the stall, not the weight. That fixture still carries a
 * multi-megapixel image per page, and pages past the first stay expensive under
 * every option set measured — a document that heavy may yet need the rendered
 * window narrowed or the raster budget capped harder. If `disableAutoFetch` is
 * ever re-added as a bandwidth saving, re-run the measurement first.
 */
export async function openPdf(
  url: string,
  options: OpenPdfOptions = {},
): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();

  const port = spawnWorkerPort();
  const task = pdfjs.getDocument({
    url,
    // `PDFWorker.create` rather than `new PDFWorker`: identical for a port
    // nothing has claimed yet, and the only one of the two whose generated
    // type declaration accepts a `port` (the constructor's is JSDoc-mangled
    // into `null | undefined`).
    worker: pdfjs.PDFWorker.create({ port, name: 'konusbitr-pdf' }),
    cMapUrl: `${ASSET_BASE}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSET_BASE}/standard_fonts/`,
    wasmUrl: `${ASSET_BASE}/wasm/`,
    disableStream: true,
    rangeChunkSize: 262144,
  });

  if (options.onProgress) {
    task.onProgress = options.onProgress;
  }

  // `destroy()` tears down the transport and the `PDFWorker`, but a `PDFWorker`
  // built from a port did not create that port and so never terminates it —
  // that thread is ours to stop, or every opened document leaks one.
  const teardown = () => {
    void task.destroy().catch(() => {});
    port.terminate();
  };

  if (options.signal?.aborted) {
    teardown();
  } else {
    options.signal?.addEventListener('abort', teardown, { once: true });
  }

  return task.promise;
}

/**
 * Why a PDF would not open, in a sentence a reader can act on.
 *
 * `design.md` §23 is explicit that an error names the problem and offers a next
 * step. PDF.js throws typed exceptions for the two cases that are actually the
 * document's fault, and everything else is ours.
 */
export function describePdfError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'PasswordException') {
    return 'This PDF is password-protected, so it cannot be displayed.';
  }
  if (name === 'InvalidPDFException') {
    return 'This file is not a readable PDF. It may have been truncated in transit.';
  }
  if (name === 'MissingPDFException' || name === 'UnexpectedResponseException') {
    return 'The document could not be fetched from storage. Reload the page to try again.';
  }
  return 'The document could not be displayed.';
}
