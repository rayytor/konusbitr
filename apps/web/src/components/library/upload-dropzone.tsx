'use client';

import { type DocumentView, UPLOAD_ACCEPT_ATTRIBUTE } from '@konusbitr/shared';
import { Link2, Upload, X } from 'lucide-react';
import { type DragEvent, useCallback, useId, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { importDocumentFromUrl, UploadError, uploadDocument } from '@/lib/upload-client';
import { cn } from '@/lib/utils';

export type InFlightUpload = {
  id: string;
  filename: string;
  percent: number;
  phase: string;
  error?: string;
};

/**
 * Putting a document in.
 *
 * `design.md` §6 is unusually specific here: the upload area is understated,
 * not the visual centre of the page, and the progress it shows is the real
 * state of a real transfer rather than an animation. Bytes go straight from the
 * browser to storage over a presigned PUT, so the percentage is genuinely the
 * percentage.
 *
 * The whole drop target is keyboard-operable because a drop target that is only
 * a drop target excludes anyone who cannot drag.
 */
export function UploadDropzone({
  uploads,
  setUploads,
  onDocument,
  className,
}: {
  uploads: InFlightUpload[];
  setUploads: React.Dispatch<React.SetStateAction<InFlightUpload[]>>;
  onDocument: (document: DocumentView) => void;
  className?: string;
}) {
  const { toast } = useToast();
  const [dragging, setDragging] = useState(false);
  const [showUrl, setShowUrl] = useState(false);
  const [url, setUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string>();

  const fileInput = useRef<HTMLInputElement>(null);
  const urlFieldId = useId();

  const send = useCallback(
    async (files: readonly File[]) => {
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
          onDocument(document);
          setUploads((current) => current.filter((row) => row.id !== id));
          toast(
            document.cached
              ? `“${document.filename}” was already read — it is ready now.`
              : `“${document.filename}” is uploading into the pipeline.`,
            { tone: 'success' },
          );
        } catch (failure) {
          const message =
            failure instanceof UploadError
              ? failure.message
              : 'That upload did not work. Try again.';
          setUploads((current) =>
            current.map((row) => (row.id === id ? { ...row, error: message } : row)),
          );
        }
      }
    },
    [onDocument, setUploads, toast],
  );

  async function importUrl(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    setImporting(true);

    try {
      const document = await importDocumentFromUrl(url.trim());
      onDocument(document);
      setUrl('');
      setShowUrl(false);
      toast(`“${document.filename}” was imported.`, { tone: 'success' });
    } catch (failure) {
      setError(
        failure instanceof UploadError ? failure.message : 'That URL could not be imported.',
      );
    } finally {
      setImporting(false);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) void send(Array.from(event.dataTransfer.files));
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {/* biome-ignore lint/a11y/useSemanticElements: a drop target has to be a container files can be dropped onto; the button role and the key handler give it the same affordances as a real button. */}
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
            'flex flex-1 cursor-pointer items-center gap-3 rounded-[var(--radius-md)]',
            'border border-dashed px-4 py-3.5',
            dragging ? 'border-accent bg-surface-muted' : 'border-border bg-surface',
          )}
        >
          <Upload aria-hidden className="size-4 shrink-0 text-foreground-subtle" />
          <span className="text-[15px]">
            Drop a PDF here<span className="text-foreground-subtle"> or choose a file</span>
          </span>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setShowUrl((current) => !current)}
          aria-expanded={showUrl}
        >
          <Link2 aria-hidden /> Import a URL
        </Button>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT_ATTRIBUTE}
        aria-label="Upload PDF documents"
        className="sr-only"
        onChange={(event) => {
          const input = event.currentTarget;
          const chosen = Array.from(input.files ?? []);
          setTimeout(() => {
            input.value = '';
          }, 0);
          if (chosen.length > 0) void send(chosen);
        }}
      />
      {showUrl ? (
        <form onSubmit={importUrl} className="flex flex-col gap-3 sm:max-w-xl">
          <Field
            id={urlFieldId}
            label="Import from a URL"
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
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={importing || url.trim() === ''}>
              {importing ? 'Importing…' : 'Import'}
            </Button>
            <Button type="button" variant="tertiary" size="sm" onClick={() => setShowUrl(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {uploads.length > 0 ? (
        <ul aria-live="polite" className="flex flex-col gap-2">
          {uploads.map((upload) => (
            <li key={upload.id} className="flex items-center gap-3 text-[15px]">
              <span className="min-w-0 flex-1 truncate text-foreground-muted">
                {upload.filename}
              </span>
              {upload.error ? (
                <>
                  <span className="text-danger">{upload.error}</span>
                  <button
                    type="button"
                    aria-label={`Dismiss the error for ${upload.filename}`}
                    onClick={() =>
                      setUploads((current) => current.filter((row) => row.id !== upload.id))
                    }
                    className="cursor-pointer text-foreground-subtle hover:text-foreground"
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </>
              ) : (
                <>
                  {/* A real progress element, so the percentage is exposed to assistive technology rather than drawn as a coloured div. */}
                  <progress
                    max={100}
                    value={upload.phase === 'uploading' ? upload.percent : undefined}
                    aria-label={`Uploading ${upload.filename}`}
                    className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-muted [&::-webkit-progress-bar]:bg-surface-muted [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent"
                  />
                  <span className="w-24 text-right tabular-nums text-foreground-subtle">
                    {upload.phase === 'uploading'
                      ? `${upload.percent}%`
                      : upload.phase === 'finishing'
                        ? 'Assembling…'
                        : 'Verifying…'}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}
