import type { DocumentView, PresignResponse } from '@konusbitr/shared';

/**
 * The browser half of the upload.
 *
 * Written by hand rather than with Uppy on purpose. What this phase needs from
 * an uploader is exactly three things — direct-to-storage PUTs, multipart above
 * a threshold, and real progress events — and all three are `XMLHttpRequest`
 * features. What Uppy adds on top is a Dashboard UI with its own visual
 * language, which `design.md` would have us override line by line and Phase 11
 * would then replace. A hundred lines here costs less than fighting a component
 * library we do not want the look of.
 *
 * `XMLHttpRequest` rather than `fetch` for one reason: upload progress.
 * `fetch` still cannot report it.
 */

export type UploadProgress = {
  /** 0–100 across the whole file, parts included. */
  percent: number;
  phase: 'uploading' | 'finishing' | 'registering';
};

export type UploadOptions = {
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  settings?: { quality?: 'standard' | 'advanced'; langList?: string[]; llm?: boolean };
  folderId?: string;
};

export class UploadError extends Error {
  override readonly name = 'UploadError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  const payload = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;

  if (!response.ok) {
    throw new UploadError(
      payload?.error?.message ?? 'That did not work. Try again.',
      payload?.error?.code ?? 'unknown',
    );
  }

  return payload as T;
}

/** One PUT, with progress. Resolves to the ETag storage assigned the object. */
function put(
  url: string,
  body: Blob,
  options: { contentType?: string; signal?: AbortSignal; onProgress?: (sent: number) => void },
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url, true);
    if (options.contentType) request.setRequestHeader('content-type', options.contentType);

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded);
    });

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        // Storage returns the part's ETag here. It is only readable when the
        // bucket's CORS policy exposes it — MinIO does by default; S3, R2 and
        // B2 need `ExposeHeaders: ["ETag"]`. See `packages/storage/README.md`.
        resolve(request.getResponseHeader('ETag'));
        return;
      }
      reject(new UploadError(`Storage refused the upload (HTTP ${request.status}).`, 'storage'));
    });

    request.addEventListener('error', () =>
      reject(new UploadError('The connection to storage failed.', 'network')),
    );
    request.addEventListener('abort', () =>
      reject(new UploadError('The upload was cancelled.', 'aborted')),
    );

    options.signal?.addEventListener('abort', () => request.abort(), { once: true });
    request.send(body);
  });
}

/**
 * Presign, upload straight to storage, then register the document.
 *
 * The file never touches the Next.js server: it goes from this function to the
 * object store, and the only thing the server hears about is an id.
 */
export async function uploadDocument(
  file: File,
  options: UploadOptions = {},
): Promise<DocumentView> {
  const ticket = await postJson<PresignResponse>(
    '/api/uploads/presign',
    { filename: file.name, mimeType: file.type || 'application/pdf', byteSize: file.size },
    options.signal,
  );

  const report = (sent: number) =>
    options.onProgress?.({
      percent: file.size === 0 ? 100 : Math.min(99, Math.round((sent / file.size) * 100)),
      phase: 'uploading',
    });

  if (ticket.strategy === 'multipart') {
    const partSize = ticket.partSize ?? 0;
    const parts = ticket.parts ?? [];
    if (partSize <= 0 || parts.length === 0) {
      throw new UploadError('The server issued an unusable upload ticket.', 'bad_ticket');
    }

    const completed: { partNumber: number; etag: string }[] = [];
    let uploadedBytes = 0;

    // Sequential, so progress is monotonic and a slow connection is not asked
    // to hold several parts in flight at once.
    for (const part of parts) {
      const start = (part.partNumber - 1) * partSize;
      const slice = file.slice(start, Math.min(start + partSize, file.size));
      const base = uploadedBytes;

      const etag = await put(part.url, slice, {
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: (sent) => report(base + sent),
      });

      if (!etag) {
        throw new UploadError(
          'Storage did not return a part identifier. Its CORS policy needs to expose the ETag header.',
          'missing_etag',
        );
      }

      uploadedBytes += slice.size;
      completed.push({ partNumber: part.partNumber, etag });
    }

    options.onProgress?.({ percent: 99, phase: 'finishing' });
    await postJson(
      '/api/uploads/complete',
      { uploadId: ticket.uploadId, parts: completed },
      options.signal,
    );
  } else {
    if (!ticket.url)
      throw new UploadError('The server issued an unusable upload ticket.', 'bad_ticket');
    await put(ticket.url, file, {
      contentType: file.type || 'application/pdf',
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: report,
    });
  }

  options.onProgress?.({ percent: 99, phase: 'registering' });

  const { document } = await postJson<{ document: DocumentView }>(
    '/api/documents',
    {
      uploadId: ticket.uploadId,
      ...(options.folderId ? { folderId: options.folderId } : {}),
      ...(options.settings ? { settings: options.settings } : {}),
    },
    options.signal,
  );

  options.onProgress?.({ percent: 100, phase: 'registering' });
  return document;
}

/** Import from a URL. The server fetches it; the guard is on that side. */
export async function importDocumentFromUrl(
  url: string,
  options: UploadOptions = {},
): Promise<DocumentView> {
  const { document } = await postJson<{ document: DocumentView }>(
    '/api/documents/from-url',
    {
      url,
      ...(options.folderId ? { folderId: options.folderId } : {}),
      ...(options.settings ? { settings: options.settings } : {}),
    },
    options.signal,
  );
  return document;
}
