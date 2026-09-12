'use client';

import { type DocumentView, UPLOAD_ACCEPT_ATTRIBUTE } from '@konusbitr/shared';
import { FileText, Trash2, Upload } from 'lucide-react';
import { type DragEvent, useId, useRef, useState } from 'react';
import { DocumentStatus } from '@/components/library/document-status';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { importDocumentFromUrl, UploadError, uploadDocument } from '@/lib/upload-client';
import { useDocumentProgress } from '@/lib/use-document-progress';
import { cn } from '@/lib/utils';

/**
 * The library: what is in it, and how to put something in it.
 *
 * Deliberately plain. Phase 11 builds the real thing — the three-column layout,
 * the viewer, the chat — and everything here is the smallest surface that lets
 * a person exercise Phase 05's intake path and see the result. What it does
 * respect, because they are not negotiable, are the rules that would be
 * expensive to retrofit: no emoji, nothing animated on hover, status shown by
 * icon as well as colour, and a drop zone that is fully usable from a keyboard.
 */

type InFlightUpload = {
  id: string;
  filename: string;
  percent: number;
  phase: string;
  error?: string;
};

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function LibraryView({ initialDocuments }: { initialDocuments: DocumentView[] }) {
  const [documents, setDocuments] = useState(initialDocuments);
  const [uploads, setUploads] = useState<InFlightUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string>();

  // Live parse progress for anything still working, over SSE. The server
  // replays current state on connect, so a refresh mid-parse resumes rather
  // than restarting at zero.
  const progress = useDocumentProgress(documents);

  const fileInput = useRef<HTMLInputElement>(null);
  const urlFieldId = useId();

  /** Put a new document at the top, or replace the row it already occupies. */
  function absorb(document: DocumentView) {
    setDocuments((current) => [document, ...current.filter((row) => row.id !== document.id)]);
  }

  async function send(files: FileList | File[]) {
    setError(undefined);

    for (const file of Array.from(files)) {
      const id = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setUploads((current) => [
        ...current,
        { id, filename: file.name, percent: 0, phase: 'uploading' },
      ]);

      try {
        const document = await uploadDocument(file, {
          onProgress: ({ percent, phase }) =>
            setUploads((current) =>
              current.map((row) => (row.id === id ? { ...row, percent, phase } : row)),
            ),
        });
        absorb(document);
        setUploads((current) => current.filter((row) => row.id !== id));
      } catch (failure) {
        const message =
          failure instanceof UploadError ? failure.message : 'That upload did not work. Try again.';
        setUploads((current) =>
          current.map((row) => (row.id === id ? { ...row, error: message } : row)),
        );
      }
    }
  }

  async function importUrl(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    setImporting(true);

    try {
      absorb(await importDocumentFromUrl(url.trim()));
      setUrl('');
    } catch (failure) {
      setError(
        failure instanceof UploadError ? failure.message : 'That URL could not be imported.',
      );
    } finally {
      setImporting(false);
    }
  }

  async function remove(document: DocumentView) {
    const confirmed = window.confirm(
      `Delete "${document.filename}"? Its file and everything derived from it are removed, and this cannot be undone.`,
    );
    if (!confirmed) return;

    const response = await fetch(`/api/documents/${document.id}`, { method: 'DELETE' });
    if (!response.ok) {
      setError('That document could not be deleted. Reload the page and try again.');
      return;
    }
    setDocuments((current) => current.filter((row) => row.id !== document.id));
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) void send(event.dataTransfer.files);
  }

  return (
    <div className="flex flex-col gap-12">
      <section className="flex flex-col gap-5">
        <h2 className="font-serif text-[24px] leading-tight">Upload a document</h2>

        {/* biome-ignore lint/a11y/useSemanticElements: a drop target has to be a
            container the file list can be dropped onto; the button role and the
            key handler below give it the same affordances as a real button. */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Drop a PDF here, or choose a file"
          onClick={() => fileInput.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              fileInput.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'flex cursor-pointer flex-col items-start gap-1 rounded-[var(--radius-md)] border border-dashed px-5 py-8',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            dragging ? 'border-accent bg-surface' : 'border-border bg-surface',
          )}
        >
          <span className="flex items-center gap-2 text-[15px]">
            <Upload aria-hidden className="size-4" />
            Drop a PDF here
          </span>
          <span className="text-[13px] text-foreground-subtle">or choose a file</span>
        </div>

        <input
          ref={fileInput}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT_ATTRIBUTE}
          className="sr-only"
          onChange={(event) => {
            if (event.target.files) void send(event.target.files);
            event.target.value = '';
          }}
        />

        {uploads.length > 0 ? (
          <ul aria-live="polite" className="flex flex-col gap-2">
            {uploads.map((upload) => (
              <li key={upload.id} className="text-[13px]">
                <span className="text-foreground-muted">{upload.filename}</span>{' '}
                {upload.error ? (
                  <span className="text-danger">{upload.error}</span>
                ) : (
                  <span className="text-foreground-subtle">
                    {upload.phase === 'uploading' ? `Uploading ${upload.percent}%` : 'Finishing'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        <form onSubmit={importUrl} className="flex flex-col gap-3 sm:max-w-xl">
          <Field
            id={urlFieldId}
            label="Or import from a URL"
            hint="Konusbitr fetches the file itself. Only public http and https addresses."
          >
            {(aria) => (
              <Input
                {...aria}
                type="url"
                inputMode="url"
                placeholder="https://example.com/report.pdf"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            )}
          </Field>
          <div>
            <Button type="submit" variant="secondary" disabled={importing || url.trim() === ''}>
              {importing ? 'Importing…' : 'Import'}
            </Button>
          </div>
        </form>

        {error ? <Alert tone="error">{error}</Alert> : null}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-serif text-[24px] leading-tight">Documents</h2>

        {documents.length === 0 ? (
          <div className="flex items-start gap-3 text-[15px] text-foreground-muted">
            <FileText aria-hidden className="mt-0.5 size-4 shrink-0" />
            <p>Your library is empty. Upload a document to start working with it.</p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {documents.map((document) => {
              const live = progress[document.id];
              return (
                <li key={document.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4">
                  <FileText aria-hidden className="size-4 shrink-0 text-foreground-subtle" />

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px]">{document.filename}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[12px] text-foreground-subtle">
                      <DocumentStatus
                        status={document.status}
                        stage={live?.stage}
                        percent={live?.percent}
                      />
                      <span>{formatSize(document.byteSize)}</span>
                      {document.pageCount ? <span>{document.pageCount} pages</span> : null}
                      <span>{formatDate(document.createdAt)}</span>
                    </p>
                    {document.error ? (
                      <p className="mt-1 text-[12px] text-danger">{document.error}</p>
                    ) : null}
                    {/* One live region per row, so a screen reader is told what
                      changed rather than having the whole list re-announced. */}
                    <p aria-live="polite" className="sr-only">
                      {live?.message ? `${document.filename}: ${live.message}` : ''}
                    </p>
                  </div>

                  <Button
                    type="button"
                    variant="danger"
                    size="icon"
                    title={`Delete ${document.filename}`}
                    aria-label={`Delete ${document.filename}`}
                    onClick={() => void remove(document)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
