/**
 * Regression tests for the PDF worker's lifecycle.
 *
 * These exist because of one bug with two halves, and both halves rendered
 * every document in the product unopenable rather than degrading anything.
 *
 * PDF.js keys a `PDFWorker` by the port it was given and
 * `PDFDocumentLoadingTask.destroy()` destroys that worker. So a single shared
 * port — `GlobalWorkerOptions.workerPort`, the shape every tutorial reaches
 * for — means the first *cancelled* load terminates the worker for the whole
 * page, and every load after it throws "PDFWorker.create - the worker is being
 * destroyed". Cancelled loads are not an edge case here: `<Viewer>` aborts on
 * unmount and the workspace remounts it as soon as the viewport media query
 * resolves, so the shared port failed on the first render, every time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FakeTask = {
  promise: Promise<unknown>;
  onProgress?: (progress: { loaded: number; total: number }) => void;
  destroy: () => Promise<void>;
};

const getDocument = vi.fn<(params: Record<string, unknown>) => FakeTask>();
const workerCreate = vi.fn((params: { port: Worker; name?: string }) => ({ ...params }));
const globalWorkerOptions: Record<string, unknown> = {};

vi.mock('pdfjs-dist', () => ({
  getDocument,
  PDFWorker: { create: workerCreate },
  GlobalWorkerOptions: globalWorkerOptions,
}));

/** Every `new Worker(...)` the module under test constructs, in order. */
const spawned: Array<{ terminate: ReturnType<typeof vi.fn> }> = [];

beforeEach(() => {
  // `loadPdfjs` memoizes its import, so without this the second test in the
  // file would inherit the first one's already-resolved module and never run
  // the code that installs a worker port.
  vi.resetModules();
  spawned.length = 0;
  getDocument.mockReset();
  workerCreate.mockClear();
  for (const key of Object.keys(globalWorkerOptions)) delete globalWorkerOptions[key];

  getDocument.mockImplementation(() => ({
    promise: Promise.resolve({ numPages: 1 }),
    destroy: () => Promise.resolve(),
  }));

  vi.stubGlobal(
    'Worker',
    class {
      terminate = vi.fn();
      constructor() {
        spawned.push(this as unknown as { terminate: ReturnType<typeof vi.fn> });
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openPdf worker lifecycle', () => {
  it('gives every load its own worker, so destroying one cannot strand another', async () => {
    const { openPdf } = await import('@/components/viewer/pdf');

    await openPdf('https://storage.example/a.pdf');
    await openPdf('https://storage.example/b.pdf');

    expect(spawned).toHaveLength(2);
    const [first, second] = workerCreate.mock.calls.map(([params]) => params.port);
    expect(first).not.toBe(second);
  });

  it('never installs a process-wide GlobalWorkerOptions.workerPort', async () => {
    const { openPdf } = await import('@/components/viewer/pdf');

    await openPdf('https://storage.example/a.pdf');

    expect(globalWorkerOptions.workerPort).toBeUndefined();
  });

  it('terminates the worker thread when the load is aborted', async () => {
    const destroy = vi.fn(() => Promise.resolve());
    getDocument.mockImplementation(() => ({
      promise: Promise.resolve({ numPages: 1 }),
      destroy,
    }));

    const { openPdf } = await import('@/components/viewer/pdf');
    const controller = new AbortController();

    await openPdf('https://storage.example/a.pdf', { signal: controller.signal });
    expect(spawned[0]?.terminate).not.toHaveBeenCalled();

    controller.abort();

    // The task is destroyed *and* the thread stopped: a `PDFWorker` built from
    // a port does not own that port and never terminates it, so a missing
    // `terminate()` leaks one thread per document opened.
    expect(destroy).toHaveBeenCalled();
    expect(spawned[0]?.terminate).toHaveBeenCalled();
  });

  it('tears down immediately when the signal is already aborted', async () => {
    const { openPdf } = await import('@/components/viewer/pdf');

    await openPdf('https://storage.example/a.pdf', { signal: AbortSignal.abort() });

    expect(spawned[0]?.terminate).toHaveBeenCalled();
  });
});
