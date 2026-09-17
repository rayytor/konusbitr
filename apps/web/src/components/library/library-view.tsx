'use client';

import {
  // Aliased: `DocumentStatus` is also the name of the badge component this
  // file renders, and the two would collide.
  type DocumentStatus as DocumentStatusValue,
  type DocumentView,
  isTerminalDocumentStatus,
  isTerminalJobStage,
} from '@konusbitr/shared';
import {
  type ColumnDef,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDownUp,
  Download,
  LayoutGrid,
  List,
  MessageSquare,
  Pencil,
  Search,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DocumentStatus } from '@/components/library/document-status';
import { DocumentThumbnail } from '@/components/library/document-thumbnail';
import { type InFlightUpload, UploadDropzone } from '@/components/library/upload-dropzone';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { Menu } from '@/components/ui/menu';
import { Segmented } from '@/components/ui/segmented';
import { useToast } from '@/components/ui/toast';
import { type DocumentProgress, formatEta, useDocumentProgress } from '@/lib/use-document-progress';
import { usePersistedState } from '@/lib/use-persisted-state';
import { cn } from '@/lib/utils';

/**
 * The library.
 *
 * `design.md` §5 asks for a digital bookshelf rather than an admin dashboard: a
 * spacious list by default, an optional compact grid, small metadata, subtle
 * dividers, and no large colourful cards. The sorting and filtering live in
 * TanStack Table and the scrolling in TanStack Virtual, because a self-hoster
 * with four thousand documents is a case this has to survive — but the row
 * markup is ours, because a generic table renderer produces exactly the dense
 * dashboard the specification is arguing against.
 */

const VIEW_KEY = 'konusbitr.library.view';
const ROW_HEIGHT = 76;
const CARD_HEIGHT = 236;
const CARD_MIN_WIDTH = 210;

type ViewMode = 'list' | 'grid';

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'ready', label: 'Ready' },
  { value: 'working', label: 'Processing' },
  { value: 'failed', label: 'Failed' },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]['value'];

const SORTS = [
  { id: 'createdAt', desc: true, label: 'Newest first' },
  { id: 'createdAt', desc: false, label: 'Oldest first' },
  { id: 'filename', desc: false, label: 'Name A–Z' },
  { id: 'filename', desc: true, label: 'Name Z–A' },
  { id: 'pageCount', desc: true, label: 'Most pages' },
] as const;

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
  const { toast } = useToast();

  const [documents, setDocuments] = useState(initialDocuments);
  const [uploads, setUploads] = useState<InFlightUpload[]>([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortIndex, setSortIndex] = useState(0);
  const [renaming, setRenaming] = useState<DocumentView | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleting, setDeleting] = useState<DocumentView | null>(null);
  const [busy, setBusy] = useState(false);

  const [view, setView] = usePersistedState<ViewMode>(
    VIEW_KEY,
    'list',
    (raw) => (raw === 'grid' || raw === 'list' ? raw : null),
    (value) => value,
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);

  // Live parse progress for anything still working, over SSE. The server
  // replays current state on connect, so a refresh mid-parse resumes.
  const progress = useDocumentProgress(documents);

  const absorb = useCallback((document: DocumentView) => {
    setDocuments((current) => [document, ...current.filter((row) => row.id !== document.id)]);
  }, []);

  // When an in-progress document reaches a terminal stage via SSE, update the
  // row from the server so pageCount, status and thumbnails are populated
  // automatically. `cancelled` is terminal too, and a row left showing
  // "Parsing" after the reader stopped it is the product ignoring them.
  useEffect(() => {
    for (const [id, frame] of Object.entries(progress)) {
      if (frame && isTerminalJobStage(frame.stage)) {
        const current = documents.find((doc) => doc.id === id);
        if (current && !isTerminalDocumentStatus(current.status as DocumentStatusValue)) {
          fetch(`/api/documents/${id}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((payload: { document?: DocumentView } | null) => {
              if (payload?.document) absorb(payload.document);
            })
            .catch(() => undefined);
        }
      }
    }
  }, [progress, documents, absorb]);

  // ── Sorting and filtering, in TanStack Table ───────────────────────────────

  const tableColumns = useMemo<ColumnDef<DocumentView>[]>(
    () => [
      { id: 'filename', accessorFn: (row) => row.filename.toLowerCase() },
      { id: 'createdAt', accessorFn: (row) => new Date(row.createdAt).getTime() },
      { id: 'pageCount', accessorFn: (row) => row.pageCount ?? 0 },
    ],
    [],
  );

  const sort = SORTS[sortIndex] ?? SORTS[0];
  const sorting: SortingState = [{ id: sort.id, desc: sort.desc }];

  const table = useReactTable({
    data: documents,
    columns: tableColumns,
    state: { sorting, globalFilter: query },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    // Matching on the filename rather than on every column: a library search
    // that matches a byte count is noise, not a feature.
    globalFilterFn: (row, _columnId, filterValue) =>
      row.original.filename.toLowerCase().includes(String(filterValue).toLowerCase()),
    getRowId: (row) => row.id,
  });

  // `table` is a stable instance whose row model is recomputed from the state
  // above, so the dependencies that matter are that state and not the object.
  const rowModel = table.getRowModel();
  const rows = useMemo(() => {
    const all = rowModel.rows.map((row) => row.original);
    if (statusFilter === 'all') return all;
    // A partially ready document is filed under "Ready": the filter is a
    // reader asking "which of these can I use?", and the answer for one whose
    // first pages are indexed is yes. It still shows its own badge and its own
    // bar in the row, so nothing is hidden by being listed here.
    if (statusFilter === 'ready') {
      return all.filter((row) => row.status === 'ready' || row.status === 'partially_ready');
    }
    // "Failed" collects the documents that need a decision, which a
    // cancellation does: the reader stopped it and may want to start again.
    if (statusFilter === 'failed') {
      return all.filter((row) => row.status === 'failed' || row.status === 'cancelled');
    }
    return all.filter(
      (row) => row.status !== 'ready' && row.status !== 'failed' && row.status !== 'cancelled',
    );
  }, [rowModel, statusFilter]);

  // ── Virtualization ─────────────────────────────────────────────────────────

  const lineCount = view === 'list' ? rows.length : Math.ceil(rows.length / columns);

  const virtualizer = useVirtualizer({
    count: lineCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (view === 'list' ? ROW_HEIGHT : CARD_HEIGHT),
    overscan: 6,
  });

  /**
   * How many cards fit across, measured rather than guessed at a breakpoint.
   *
   * A ref callback that returns its own cleanup — React 19 calls the returned
   * function when the node goes away, which is what disconnects the observer
   * when the library switches back to the list view.
   */
  const measureColumns = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      setColumns(Math.max(1, Math.floor(width / CARD_MIN_WIDTH)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // ── Mutations ──────────────────────────────────────────────────────────────

  async function rename() {
    const target = renaming;
    const filename = renameDraft.trim();
    if (!target || filename === '' || filename === target.filename) {
      setRenaming(null);
      return;
    }

    setBusy(true);
    const previous = documents;
    // Optimistic: the row changes immediately and is put back if the server
    // disagrees, which is what makes a rename feel like editing a label.
    setDocuments((current) =>
      current.map((row) => (row.id === target.id ? { ...row, filename } : row)),
    );

    try {
      const response = await fetch(`/api/documents/${target.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename }),
      });
      if (!response.ok) throw new Error('rename failed');
      toast('Renamed.', { tone: 'success' });
    } catch {
      setDocuments(previous);
      toast('That document could not be renamed.', { tone: 'error' });
    } finally {
      setBusy(false);
      setRenaming(null);
    }
  }

  async function remove() {
    const target = deleting;
    if (!target) return;

    setBusy(true);
    const previous = documents;
    setDocuments((current) => current.filter((row) => row.id !== target.id));

    try {
      const response = await fetch(`/api/documents/${target.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('delete failed');
      toast(`“${target.filename}” was deleted.`, { tone: 'success' });
    } catch {
      setDocuments(previous);
      toast('That document could not be deleted.', { tone: 'error' });
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  }

  function actionsFor(document: DocumentView) {
    return [
      {
        label: 'Rename',
        icon: Pencil,
        onSelect: () => {
          setRenameDraft(document.filename);
          setRenaming(document);
        },
      },
      {
        label: 'Download',
        icon: Download,
        onSelect: () => window.open(`/api/documents/${document.id}/file`, '_blank', 'noopener'),
      },
      {
        label: 'Delete',
        icon: Trash2,
        destructive: true,
        onSelect: () => setDeleting(document),
      },
    ];
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const empty = documents.length === 0;
  const filteredEmpty = !empty && rows.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-5 px-6 pt-8 pb-5 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-serif text-[30px] leading-tight tracking-tight">Library</h1>
            <p className="mt-1 text-[15px] text-foreground-muted">
              {documents.length === 0
                ? 'Nothing here yet.'
                : `${documents.length} ${documents.length === 1 ? 'document' : 'documents'}`}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Menu
              label="Sort documents"
              items={SORTS.map((option, index) => ({
                label: option.label,
                onSelect: () => setSortIndex(index),
              }))}
              trigger={(props) => (
                <Button {...props} variant="secondary" size="sm">
                  <ArrowDownUp aria-hidden />
                  {sort.label}
                </Button>
              )}
            />
            <Segmented
              label="Layout"
              iconOnly
              value={view}
              onChange={setView}
              options={[
                { value: 'list', label: 'List view', icon: List },
                { value: 'grid', label: 'Grid view', icon: LayoutGrid },
              ]}
            />
          </div>
        </div>

        <UploadDropzone uploads={uploads} setUploads={setUploads} onDocument={absorb} />

        {empty ? null : (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-48 flex-1 items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-surface px-2.5">
              <Search aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by name"
                aria-label="Filter documents by name"
                className="h-9 min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-foreground-subtle focus-visible:outline-none"
              />
            </div>
            <Segmented
              label="Status"
              value={statusFilter}
              onChange={setStatusFilter}
              options={STATUS_FILTERS}
            />
          </div>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 sm:px-8">
        {empty ? (
          <EmptyLibrary />
        ) : filteredEmpty ? (
          <p className="py-12 text-center text-[15px] text-foreground-muted">
            No document matches that filter.
          </p>
        ) : (
          <div ref={measureColumns}>
            <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
              {virtualizer.getVirtualItems().map((line) => {
                const slice =
                  view === 'list'
                    ? rows.slice(line.index, line.index + 1)
                    : rows.slice(line.index * columns, line.index * columns + columns);

                return (
                  <div
                    key={line.key}
                    data-index={line.index}
                    ref={virtualizer.measureElement}
                    className={cn(
                      'absolute top-0 left-0 w-full',
                      view === 'grid' ? 'grid gap-4 pb-4' : '',
                    )}
                    style={{
                      transform: `translateY(${line.start}px)`,
                      ...(view === 'grid'
                        ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
                        : {}),
                    }}
                  >
                    {slice.map((document) =>
                      view === 'list' ? (
                        <DocumentRow
                          key={document.id}
                          document={document}
                          live={progress[document.id]}
                          actions={actionsFor(document)}
                        />
                      ) : (
                        <DocumentCard
                          key={document.id}
                          document={document}
                          live={progress[document.id]}
                          actions={actionsFor(document)}
                        />
                      ),
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <Dialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename document"
        description="The name is a label. Nothing about the file, its parse or its index changes."
        confirmLabel="Rename"
        onConfirm={() => void rename()}
        busy={busy}
      >
        <Input
          aria-label="Document name"
          value={renameDraft}
          onChange={(event) => setRenameDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void rename();
          }}
        />
      </Dialog>

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this document?"
        description={
          deleting
            ? `“${deleting.filename}”, its pages, its passages and its file are removed. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => void remove()}
        busy={busy}
      />
    </div>
  );
}

type RowProps = {
  document: DocumentView;
  live?: DocumentProgress | undefined;
  actions: { label: string; icon: typeof Pencil; onSelect: () => void; destructive?: boolean }[];
};

/**
 * Whether a row is still moving, in the one place both layouts read it.
 *
 * `partially_ready` counts as working, which is the whole of Phase 12.4 in one
 * predicate: the document can be opened and asked questions *and* pages are
 * still arriving, so the row shows a badge that says it is readable and a bar
 * that says it is not finished.
 */
function isRowWorking(document: DocumentView, live?: DocumentProgress): boolean {
  const stage = live?.stage;
  if (stage !== undefined) {
    return stage !== 'ready' && stage !== 'failed' && stage !== 'cancelled';
  }
  return (
    document.status !== 'ready' && document.status !== 'failed' && document.status !== 'cancelled'
  );
}

/**
 * How far a long document has got, as a phrase — or nothing.
 *
 * Nothing is the common case and is deliberate: a ten-page PDF is read in one
 * batch and never reports a page count, and "Page 10 of 10" beside a bar that
 * is about to disappear is noise. The phrase only appears where it earns its
 * place, on a document long enough that a percentage alone is a spinner.
 */
function pageProgress(document: DocumentView, live?: DocumentProgress): string | undefined {
  const ready = live?.pagesReady ?? document.pagesReady ?? 0;
  const total = live?.pagesTotal ?? document.pagesTotal ?? 0;
  if (!total || ready <= 0 || ready >= total) return undefined;
  const eta = live?.etaSeconds;
  return eta === undefined
    ? `page ${ready} of ${total}`
    : `page ${ready} of ${total} · ${formatEta(eta)} left`;
}

function DocumentRow({ document, live, actions }: RowProps) {
  const isWorking = isRowWorking(document, live);
  const percent = live?.percent;
  const pages = pageProgress(document, live);

  return (
    <div
      data-document-id={document.id}
      className="flex items-center gap-4 border-b border-border-subtle py-3.5"
    >
      <DocumentThumbnail
        documentId={document.id}
        filename={document.filename}
        available={document.pageCount !== null}
        className="h-12 w-9"
      />

      <div className="min-w-0 flex-1">
        <Link
          href={`/documents/${document.id}`}
          className="block truncate text-[15px] text-foreground"
        >
          {document.filename}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-foreground-subtle">
          <DocumentStatus
            status={document.status}
            {...(live ? { stage: live.stage, percent: live.percent } : {})}
          />
          {isWorking ? (
            <div className="flex items-center gap-2">
              <progress
                max={100}
                value={percent !== undefined && percent > 0 ? percent : undefined}
                aria-label={`Processing ${document.filename}: ${percent !== undefined ? Math.round(percent) : 0}%`}
                className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-muted [&::-webkit-progress-bar]:bg-surface-muted [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent"
              />
            </div>
          ) : null}
          {pages ? <span className="tabular-nums">{pages}</span> : null}
          <span>{formatSize(document.byteSize)}</span>
          {document.pageCount ? <span>{document.pageCount} pages</span> : null}
          <span>{formatDate(document.createdAt)}</span>
        </div>
        {document.error ? <p className="mt-1 text-[15px] text-danger">{document.error}</p> : null}
        {/* One live region per row, so a screen reader is told what changed
            rather than having the whole list re-announced. */}
        <p aria-live="polite" className="sr-only">
          {live?.message ? `${document.filename}: ${live.message}` : ''}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button asChild variant="tertiary" size="sm">
          <Link href={`/documents/${document.id}`}>
            <MessageSquare aria-hidden />
            Open
          </Link>
        </Button>
        <RowMenu filename={document.filename} actions={actions} />
      </div>
    </div>
  );
}

function DocumentCard({ document, live, actions }: RowProps) {
  const isWorking = isRowWorking(document, live);
  const percent = live?.percent;

  return (
    <div data-document-id={document.id} className="flex flex-col gap-2.5">
      <Link
        href={`/documents/${document.id}`}
        aria-label={`Open ${document.filename}`}
        className="block"
      >
        <DocumentThumbnail
          documentId={document.id}
          filename={document.filename}
          available={document.pageCount !== null}
          className="h-40 w-full"
        />
      </Link>
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <Link
            href={`/documents/${document.id}`}
            className="block truncate text-[15px] text-foreground"
          >
            {document.filename}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-foreground-subtle">
            <DocumentStatus
              status={document.status}
              {...(live ? { stage: live.stage, percent: live.percent } : {})}
            />
            {document.pageCount ? <span>{document.pageCount} pp.</span> : null}
          </div>
          {isWorking ? (
            <div className="mt-1.5 flex items-center gap-2">
              <progress
                max={100}
                value={percent !== undefined && percent > 0 ? percent : undefined}
                aria-label={`Processing ${document.filename}: ${percent !== undefined ? Math.round(percent) : 0}%`}
                className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted [&::-webkit-progress-bar]:bg-surface-muted [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent"
              />
            </div>
          ) : null}
        </div>
        <RowMenu filename={document.filename} actions={actions} />
      </div>
    </div>
  );
}

function RowMenu({ filename, actions }: { filename: string; actions: RowProps['actions'] }) {
  return (
    <Menu
      label={`Actions for ${filename}`}
      items={actions}
      trigger={(props) => (
        <Button {...props} variant="tertiary" size="icon" aria-label={`Actions for ${filename}`}>
          <span aria-hidden className="text-[18px] leading-none">
            ⋯
          </span>
        </Button>
      )}
    />
  );
}

function EmptyLibrary() {
  return (
    <div className="flex flex-col items-start gap-3 py-16">
      <h2 className="font-serif text-[24px] leading-tight">Your library is empty</h2>
      <p className="max-w-prose text-[15px] leading-relaxed text-foreground-muted">
        Upload a PDF and Konusbitr will read it, page by page, and index every passage with the
        place it came from. Uploading the same file twice costs nothing the second time.
      </p>
    </div>
  );
}
