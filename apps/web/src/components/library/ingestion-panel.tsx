'use client';

import type { DocumentView, JobErrorCode, ParseQuality } from '@konusbitr/shared';
import { CircleAlert, CircleStop, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { DocumentStatus } from '@/components/library/document-status';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { type DocumentProgress, formatEta } from '@/lib/use-document-progress';
import { cn } from '@/lib/utils';

/**
 * What a reader sees while a long document is being read, and after it goes wrong.
 *
 * Phase 06 gave the library a status word and a thin bar, which is the right
 * amount of interface for the ten-page PDF most uploads are. It is not enough
 * for the documents this phase exists for: a 900-page scan spends a quarter of
 * an hour at "Reading text", and a bar with no denominator is indistinguishable
 * from a deadlock.
 *
 * So this panel says four things a bar cannot, and each of them is a decision:
 *
 * **Where it is, in pages.** A reader knows how long their document is. "142 of
 * 900 pages" is something they can reason about and 23% is not.
 *
 * **How long is left, when that can be estimated honestly.** From the rate
 * pages have actually been arriving, not from a constant — and omitted
 * entirely rather than guessed. See `useDocumentProgress`.
 *
 * **That it can be stopped.** A reader who uploaded the wrong file should not
 * have to wait fifteen minutes or delete the document to get out of it.
 *
 * **What to do when it failed.** An error code is a thing to act on, not a
 * thing to display: a scan refused for want of a recogniser and a PDF with a
 * shredded xref table are both "Failed" and have completely different answers.
 *
 * `design.md` applies unchanged: an icon and a word rather than colour alone,
 * no motion on hover, no emoji, and hierarchy from type and space rather than
 * from a card with a border.
 */

/**
 * What each terminal failure means and what the reader can do about it.
 *
 * Keyed on the stable `JOB_ERROR_CODES` vocabulary rather than on the message,
 * because the message is a sentence written for a person and will be reworded,
 * while the code is the contract. Anything not listed falls through to a
 * generic entry — a client must never meet a code it has no branch for.
 */
const FAILURES: Partial<
  Record<JobErrorCode, { title: string; detail: string; retryable: boolean }>
> = {
  needs_ocr: {
    title: 'This document has no text to read',
    detail:
      'It looks like a scan or a photograph of a page. Text recognition either is not switched on for this instance, or could not find any words. An administrator can enable it, and then this is worth trying again.',
    retryable: true,
  },
  encrypted_document: {
    title: 'This PDF is password-protected',
    detail:
      'Konusbitr cannot open an encrypted file. Remove the password in a PDF reader and upload it again — retrying will not help while the file is still locked.',
    retryable: false,
  },
  corrupt_document: {
    title: 'This file is damaged',
    detail:
      'The PDF structure could not be read. It was most likely truncated during download or export. Re-export or re-download the original and upload it again.',
    retryable: false,
  },
  unsupported_format: {
    title: 'This file is not a PDF',
    detail: 'Konusbitr reads PDFs. Convert the file to PDF and upload it again.',
    retryable: false,
  },
  too_many_pages: {
    title: 'This document is too long',
    detail:
      'It is longer than this instance allows. An administrator can raise the limit, or the document can be split and uploaded in parts.',
    retryable: true,
  },
  object_missing: {
    title: 'The uploaded file could not be found',
    detail: 'The upload did not finish, so there is nothing stored to read. Upload the file again.',
    retryable: false,
  },
  content_hash_mismatch: {
    title: 'The stored file changed underneath this document',
    detail: 'Upload the file again to start a fresh document.',
    retryable: false,
  },
  model_unavailable: {
    title: 'A model this instance needs did not answer',
    detail:
      'The embedding or vision model could not be reached. This is usually temporary — try again, and tell an administrator if it keeps happening.',
    retryable: true,
  },
  out_of_memory: {
    title: 'The worker ran out of memory',
    detail:
      'This document needed more memory than the worker has. Trying again may succeed; an administrator can also give the worker more memory.',
    retryable: true,
  },
};

const GENERIC_FAILURE = {
  title: 'This document could not be processed',
  detail:
    'Something went wrong while reading it. Trying again is usually worth it; if it fails the same way twice, the file itself is probably the problem.',
  retryable: true,
};

/**
 * The quality tiers a retry may choose between.
 *
 * `advanced` exists in the contract and arrives properly with the VLM pipeline;
 * it is offered here because the settings a retry uses are the *document's*
 * identity, and a reader who wants to re-read a difficult scan at a higher tier
 * should be able to ask for it from the place the failure is shown rather than
 * by re-uploading.
 */
const QUALITIES: { value: ParseQuality; label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'advanced', label: 'Advanced' },
];

export function IngestionPanel({
  document,
  progress,
  onChanged,
  className,
}: {
  document: DocumentView;
  progress?: DocumentProgress;
  /** Called after a cancel or retry, so the caller can refresh its list. */
  onChanged?: () => void;
  className?: string;
}) {
  const stage = progress?.stage ?? document.status;
  const failed = stage === 'failed' || document.status === 'failed';
  const cancelled = stage === 'cancelled' || document.status === 'cancelled';

  if (failed || cancelled) {
    return (
      <RecoveryPanel
        document={document}
        cancelled={cancelled}
        onChanged={onChanged}
        className={className}
      />
    );
  }

  if (stage === 'ready' || document.status === 'ready') return null;

  return (
    <ProgressPanel
      document={document}
      progress={progress}
      onChanged={onChanged}
      className={className}
    />
  );
}

function ProgressPanel({
  document,
  progress,
  onChanged,
  className,
}: {
  document: DocumentView;
  progress?: DocumentProgress;
  onChanged?: () => void;
  className?: string;
}) {
  const [stopping, setStopping] = useState(false);
  const pagesReady = progress?.pagesReady ?? document.pagesReady ?? 0;
  const pagesTotal = progress?.pagesTotal ?? document.pagesTotal ?? 0;
  const percent = progress?.percent ?? 0;
  const partial = document.status === 'partially_ready' && pagesReady > 0;

  async function cancel() {
    setStopping(true);
    try {
      await fetch(`/api/documents/${document.id}/cancel`, { method: 'POST' });
      onChanged?.();
    } finally {
      setStopping(false);
    }
  }

  return (
    <section
      className={cn('flex flex-col gap-3', className)}
      // The whole panel rather than the counter alone: a screen reader that
      // announced only "142" would be reading a number with no subject. The
      // region is polite so it never interrupts, and the text inside it is
      // written to be read aloud as a sentence.
      aria-live="polite"
      aria-busy
    >
      <div className="flex items-baseline justify-between gap-3">
        <DocumentStatus status={document.status} stage={progress?.stage} />
        {pagesTotal > 0 ? (
          <span className="text-[13px] text-foreground-muted tabular-nums">
            Page {pagesReady} of {pagesTotal}
          </span>
        ) : null}
      </div>

      <progress
        max={100}
        value={percent > 0 ? percent : undefined}
        aria-label={
          pagesTotal > 0
            ? `Reading page ${pagesReady} of ${pagesTotal}`
            : `Processing, ${Math.round(percent)} percent complete`
        }
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted [&::-webkit-progress-bar]:bg-surface-muted [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent"
      />

      <p className="text-[13px] text-foreground-muted">
        {progress?.message ?? 'Preparing the document'}
        {progress?.etaSeconds !== undefined ? <> · {formatEta(progress.etaSeconds)} left</> : null}
      </p>

      {partial ? (
        <p className="text-[13px] text-foreground-muted">
          You can read and ask questions about the {pagesReady} pages that are ready while the rest
          is indexed.
        </p>
      ) : null}

      <div>
        <Button variant="tertiary" size="sm" onClick={cancel} disabled={stopping}>
          <CircleStop aria-hidden className="size-3.5" />
          {stopping ? 'Stopping' : 'Cancel ingestion'}
        </Button>
      </div>
    </section>
  );
}

function RecoveryPanel({
  document,
  cancelled,
  onChanged,
  className,
}: {
  document: DocumentView;
  cancelled: boolean;
  onChanged?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [quality, setQuality] = useState<ParseQuality>('standard');
  const [retrying, setRetrying] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  const failure = cancelled
    ? {
        title: 'You stopped this document',
        detail:
          document.pagesReady && document.pagesReady > 0
            ? `The ${document.pagesReady} pages that had been read are still searchable. Start again to read the rest.`
            : 'Nothing was indexed. Start again whenever you like.',
        retryable: true,
      }
    : (FAILURES[document.errorCode as JobErrorCode] ?? GENERIC_FAILURE);

  async function retry() {
    setRetrying(true);
    setProblem(undefined);
    try {
      const response = await fetch(`/api/documents/${document.id}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { quality, langList: [], llm: false } }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setProblem(body?.error?.message ?? 'That could not be started again.');
        return;
      }
      setOpen(false);
      onChanged?.();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <section className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-start gap-2">
        <CircleAlert
          aria-hidden
          className={cn(
            'mt-0.5 size-4 shrink-0',
            cancelled ? 'text-foreground-muted' : 'text-danger',
          )}
        />
        <div className="flex flex-col gap-1">
          <p className="text-[15px]">{failure.title}</p>
          <p className="text-[13px] text-foreground-muted">{failure.detail}</p>
        </div>
      </div>

      {failure.retryable ? (
        <div>
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            <RotateCcw aria-hidden className="size-3.5" />
            Retry with settings
          </Button>
        </div>
      ) : null}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Read this document again"
        description="Choose how thoroughly to read it. Reading again does not re-upload the file."
        confirmLabel={retrying ? 'Starting' : 'Read again'}
        onConfirm={retry}
        busy={retrying}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-foreground-muted">Parsing quality</span>
            <Segmented
              label="Parsing quality"
              value={quality}
              onChange={setQuality}
              options={QUALITIES}
            />
          </div>

          {problem ? (
            <p className="text-[13px] text-danger" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
      </Dialog>
    </section>
  );
}
