'use client';

import {
  type DocumentView,
  type EstimateCostResponse,
  UPLOAD_ACCEPT_ATTRIBUTE,
} from '@konusbitr/shared';
import { Link2, Upload, X } from 'lucide-react';
import { type DragEvent, useCallback, useId, useRef, useState } from 'react';
import { AdvancedConfirm } from '@/components/library/advanced-confirm';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { useToast } from '@/components/ui/toast';
import { importDocumentFromUrl, UploadError, uploadDocument } from '@/lib/upload-client';
import { cn } from '@/lib/utils';

type Quality = 'standard' | 'advanced';

/**
 * The page count a URL import is priced at before the file has been fetched.
 *
 * Deliberately large: the server clamps it to `MAX_VLM_PAGES_PER_JOB` and
 * answers for the ceiling, which is the worst case and therefore the only
 * honest number to show for a document nobody has opened yet.
 */
const CEILING_PROBE = 100_000;

const QUALITY_OPTIONS = [
  { value: 'standard' as const, label: 'Standard' },
  { value: 'advanced' as const, label: 'Advanced' },
];

/**
 * Work waiting for somebody to approve what reading it will cost.
 *
 * The confirmation is per *batch* rather than per file, because that is how
 * people drop things: five documents at once, one decision. `label` is what the
 * dialog names — one file by name, several by count, a URL by its address.
 *
 * `run` rather than a file list, because the two things that need confirming
 * are submitted differently: a dropped batch goes through `send` and a URL goes
 * through `importUrl`. Carrying the continuation keeps the dialog from having
 * to know which it is looking at.
 */
type PendingAdvanced = {
  label: string;
  estimate: EstimateCostResponse | null;
  /** True when the estimate is for the page ceiling rather than a real count. */
  worstCase: boolean;
  run: () => void;
};

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
  const [quality, setQuality] = useState<Quality>('standard');
  const [pendingAdvanced, setPendingAdvanced] = useState<PendingAdvanced>();

  const fileInput = useRef<HTMLInputElement>(null);
  const urlFieldId = useId();

  const send = useCallback(
    async (files: readonly File[], chosen: Quality) => {
      setError(undefined);

      for (const file of Array.from(files)) {
        const id = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setUploads((current) => [
          ...current,
          { id, filename: file.name, percent: 0, phase: 'uploading' },
        ]);

        try {
          const document = await uploadDocument(file, {
            settings: { quality: chosen },
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

  /**
   * Ask what a page count would cost. `null` when the server could not say.
   */
  const priceOf = useCallback(async (pages: number): Promise<EstimateCostResponse | null> => {
    try {
      const response = await fetch('/api/documents/estimate-cost', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pageCount: Math.max(1, pages), quality: 'advanced' }),
      });
      return (await response.json()) as EstimateCostResponse;
    } catch {
      return null;
    }
  }, []);

  /**
   * The gate every batch of files passes through.
   *
   * Standard quality goes straight to the uploader — it costs the operator's
   * own CPU and there is nothing to agree to. Advanced counts the pages *in the
   * browser*, before a byte is transferred, asks the server what that would
   * cost, and shows the answer. Counting locally is the whole point: being told
   * a 400-page document is too long after uploading it is not a guardrail.
   */
  const accept = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return;
      if (quality === 'standard') {
        void send(files, 'standard');
        return;
      }

      const label = files.length === 1 ? (files[0]?.name ?? '') : `${files.length} documents`;
      const run = () => void send(files, 'advanced');

      setError(undefined);
      setPendingAdvanced({ label, estimate: null, worstCase: false, run });

      const { countPdfPages } = await import('@/components/viewer/pdf');
      const counted = await Promise.all(files.map((file) => countPdfPages(file)));
      // A file PDF.js could not open contributes nothing to the count rather
      // than blocking the batch: intake has a better refusal waiting for it.
      const pages = counted.reduce((total: number, count) => total + (count ?? 0), 0);

      const estimate = await priceOf(pages);
      if (estimate === null) {
        setPendingAdvanced(undefined);
        setError('That estimate could not be fetched. Try again, or upload at standard quality.');
        return;
      }
      setPendingAdvanced({ label, estimate, worstCase: false, run });
    },
    [priceOf, quality, send],
  );

  const importNow = useCallback(
    async (target: string, chosen: Quality) => {
      setError(undefined);
      setImporting(true);

      try {
        const document = await importDocumentFromUrl(target, { settings: { quality: chosen } });
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
    },
    [onDocument, toast],
  );

  /**
   * A URL import at advanced quality, confirmed against the worst case.
   *
   * The page count cannot be known here: the file is on somebody else's server
   * and only Konusbitr will fetch it. So the estimate quoted is for the page
   * ceiling — the most this document could possibly cost before intake refuses
   * it — and the dialog says that is what it is. Quoting a single page to keep
   * the number small would be the wrong kind of reassuring, and skipping the
   * confirmation entirely would make the URL path the way to avoid one.
   */
  async function importUrl(event: React.FormEvent) {
    event.preventDefault();
    const target = url.trim();
    if (!target) return;

    if (quality === 'standard') {
      void importNow(target, 'standard');
      return;
    }

    setError(undefined);
    const run = () => void importNow(target, 'advanced');
    setPendingAdvanced({ label: target, estimate: null, worstCase: true, run });

    const estimate = await priceOf(CEILING_PROBE);
    if (estimate === null) {
      setPendingAdvanced(undefined);
      setError('That estimate could not be fetched. Try again, or import at standard quality.');
      return;
    }
    setPendingAdvanced({
      label: target,
      estimate: { ...estimate, pageCount: estimate.maxPages },
      worstCase: true,
      run,
    });
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) void accept(Array.from(event.dataTransfer.files));
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
        <Segmented
          value={quality}
          onChange={setQuality}
          options={QUALITY_OPTIONS}
          label="Parsing quality"
        />
        <Button
          type="button"
          variant="secondary"
          onClick={() => setShowUrl((current) => !current)}
          aria-expanded={showUrl}
        >
          <Link2 aria-hidden /> Import a URL
        </Button>
      </div>
      {/* Stated once, quietly, rather than as a badge on the toggle: the
          difference between the tiers is what they cost, and somebody choosing
          between them is owed that in words before they are shown a price. */}
      {quality === 'advanced' ? (
        <p className="text-[13px] text-foreground-subtle">
          The advanced reader looks at every page with a vision model. It recovers reading order and
          headings on complex layouts, and it costs money per page — you will see an estimate before
          anything is uploaded.
        </p>
      ) : null}
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT_ATTRIBUTE}
        aria-label="Upload PDF documents"
        className="sr-only"
        onChange={(event) => {
          const input = event.currentTarget;
          const files = Array.from(input.files ?? []);
          setTimeout(() => {
            input.value = '';
          }, 0);
          if (files.length > 0) void accept(files);
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
      <AdvancedConfirm
        open={pendingAdvanced !== undefined}
        estimate={pendingAdvanced?.estimate ?? null}
        filename={pendingAdvanced?.label ?? ''}
        worstCase={pendingAdvanced?.worstCase ?? false}
        pending={pendingAdvanced !== undefined && pendingAdvanced.estimate === null}
        onCancel={() => setPendingAdvanced(undefined)}
        onConfirm={() => {
          const pending = pendingAdvanced;
          setPendingAdvanced(undefined);
          pending?.run();
        }}
      />
    </div>
  );
}
