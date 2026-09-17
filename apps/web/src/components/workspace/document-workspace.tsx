'use client';

import type { ChatMessageView, Citation, DocumentView } from '@konusbitr/shared';
import {
  ArrowLeft,
  Download,
  Eraser,
  FileText,
  Library,
  Loader,
  MessageSquare,
  Moon,
  Pencil,
  RefreshCw,
  Search,
  Sun,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatPane } from '@/components/chat/chat-pane';
import { DocumentStatus } from '@/components/library/document-status';
import { IngestionPanel } from '@/components/library/ingestion-panel';
import { useTheme } from '@/components/theme-provider';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { type Command, CommandPalette } from '@/components/ui/command-palette';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { IconButton } from '@/components/ui/icon-button';
import { Menu } from '@/components/ui/menu';
import { SplitPane } from '@/components/ui/split-pane';
import { useToast } from '@/components/ui/toast';
import { Viewer } from '@/components/viewer';
import type { PageGeometry } from '@/components/viewer/geometry';
import type { ViewerHandle } from '@/components/viewer/types';
import { type DocumentProgress, formatEta, useDocumentProgress } from '@/lib/use-document-progress';
import { usePersistedNumber } from '@/lib/use-persisted-state';
import { cn } from '@/lib/utils';

const SPLIT_KEY = 'konusbitr.workspace.split';
const DEFAULT_SPLIT = 0.58;

/**
 * Whether the document has pages the viewer can render.
 *
 * `partially_ready` is in on purpose: pages, geometry, chunks and vectors all
 * exist for everything read so far, so the viewer opens and chat answers over
 * the indexed part while the rest is still being read.
 */
function readableStatus(status: string | undefined): boolean {
  return status === 'ready' || status === 'partially_ready';
}

/**
 * The document workspace: the viewer, the chat, and the line between them.
 *
 * This is the product. Everything Phases 05–10 built is invisible until a
 * reader can ask a question, get an answer, click `p. 42` and watch the
 * sentence light up on the page — so the one interaction this component exists
 * to make work is `onCitationSelect` below, and every other decision here
 * defers to it.
 *
 * Layout follows `design.md` §21: a resizable split on a wide screen, and two
 * tabs on a narrow one. Not a squeezed split — a phone showing a 40%-wide PDF
 * next to a 60%-wide chat is worse at both jobs than a phone showing one of
 * them.
 */
export function DocumentWorkspace({
  document: initialDocument,
  pages,
  viewUrl,
  downloadUrl,
  conversationId,
  initialMessages,
}: {
  document: DocumentView;
  pages: PageGeometry[];
  viewUrl: string;
  downloadUrl: string;
  conversationId: string | null;
  initialMessages: ChatMessageView[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { resolved, setTheme } = useTheme();

  const [doc, setDoc] = useState(initialDocument);
  const [split, setSplit] = usePersistedNumber(SPLIT_KEY, DEFAULT_SPLIT, { min: 0.25, max: 0.8 });
  const [tab, setTab] = useState<'document' | 'chat'>('chat');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(doc.filename);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeCitationId, setActiveCitationId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const viewer = useRef<ViewerHandle>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  // ── Live parse progress ────────────────────────────────────────────────────

  const watched = useMemo(() => [doc], [doc]);
  const progress = useDocumentProgress(watched);
  const live = progress[doc.id];

  const documentId = doc.id;

  const refresh = useCallback(() => {
    fetch(`/api/documents/${documentId}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { document?: DocumentView } | null) => {
        if (payload?.document) setDoc(payload.document);
      })
      .catch(() => undefined);
  }, [documentId]);

  // Whether the live stream says there is something new to read out of the row.
  //
  // Two occasions, not one. A terminal stage is the Phase 06 case: the pipeline
  // finished and the row is the source of truth for everything else about the
  // document. The second is Phase 12.4's — the first batch of a long ingest has
  // landed, which is the moment the status becomes `partially_ready` and the
  // viewer may open. Waiting for `ready` there would keep a reader on a spinner
  // for the fifteen minutes partial readiness exists to give back to them.
  const finished =
    live !== undefined &&
    (live.stage === 'ready' || live.stage === 'failed' || live.stage === 'cancelled');
  const firstPagesLanded = (live?.pagesReady ?? 0) > 0;
  const shouldReread = finished || (firstPagesLanded && !readableStatus(doc.status));

  useEffect(() => {
    if (!shouldReread) return;

    fetch(`/api/documents/${documentId}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { document?: DocumentView } | null) => {
        if (payload?.document) setDoc(payload.document);
        // Pages, and therefore page geometry, only exist once the parse has
        // written them — so a document that became readable in this session
        // needs a real reload rather than a patched object. That includes the
        // first batch of a long one: `partially_ready` means there are pages
        // to render that this render pass has never seen.
        if (readableStatus(payload?.document?.status)) router.refresh();
      })
      .catch(() => undefined);
  }, [shouldReread, documentId, router]);

  // ── Citations ──────────────────────────────────────────────────────────────

  const onCitationSelect = useCallback((citation: Citation, id: string) => {
    setActiveCitationId(id);
    setTab('document');
    viewer.current?.showCitation(citation, id);
    setAnnouncement(
      `Showing page ${citation.page}: “${citation.quote.slice(0, 140)}${
        citation.quote.length > 140 ? '…' : ''
      }”`,
    );
  }, []);

  const clearHighlights = useCallback(() => {
    viewer.current?.clearHighlights();
    setActiveCitationId(null);
    setAnnouncement('Citation highlights cleared.');
  }, []);

  // ── Mutations ──────────────────────────────────────────────────────────────

  async function rename() {
    const filename = renameDraft.trim();
    if (filename === '' || filename === doc.filename) {
      setRenaming(false);
      return;
    }

    setBusy(true);
    const previous = doc;
    setDoc({ ...doc, filename });

    try {
      const response = await fetch(`/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename }),
      });
      if (!response.ok) throw new Error('rename failed');
      const payload = (await response.json()) as { document: DocumentView };
      setDoc(payload.document);
      toast('Renamed.', { tone: 'success' });
    } catch {
      setDoc(previous);
      toast('That document could not be renamed.', { tone: 'error' });
    } finally {
      setBusy(false);
      setRenaming(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const response = await fetch(`/api/documents/${doc.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('delete failed');
      toast(`“${doc.filename}” was deleted.`, { tone: 'success' });
      router.push('/documents');
    } catch {
      toast('That document could not be deleted.', { tone: 'error' });
      setBusy(false);
      setDeleting(false);
    }
  }

  const reindex = useCallback(async () => {
    try {
      const response = await fetch(`/api/documents/${doc.id}/reindex`, { method: 'POST' });
      if (!response.ok) throw new Error('reindex failed');
      toast('Re-indexing. The document stays readable while it runs.', { tone: 'success' });
    } catch {
      toast('Re-indexing could not be started.', { tone: 'error' });
    }
  }, [doc.id, toast]);

  // ── Keyboard ───────────────────────────────────────────────────────────────

  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'focus-chat',
        label: 'Ask a question',
        icon: MessageSquare,
        shortcut: '⌘/',
        run: () => {
          setTab('chat');
          composer.current?.focus();
        },
      },
      {
        id: 'find',
        label: 'Find in document',
        icon: Search,
        shortcut: '⌘F',
        run: () => {
          setTab('document');
          viewer.current?.openSearch();
        },
      },
      {
        id: 'clear',
        label: 'Clear citation highlights',
        icon: Eraser,
        shortcut: 'Esc',
        run: clearHighlights,
      },
      {
        id: 'library',
        label: 'Go to library',
        icon: Library,
        run: () => router.push('/documents'),
      },
      {
        id: 'rename',
        label: 'Rename document',
        icon: Pencil,
        run: () => {
          setRenameDraft(doc.filename);
          setRenaming(true);
        },
      },
      {
        id: 'download',
        label: 'Download original',
        icon: Download,
        run: () => window.open(downloadUrl, '_blank', 'noopener'),
      },
      {
        id: 'reindex',
        label: 'Re-index this document',
        icon: RefreshCw,
        run: () => void reindex(),
      },
      {
        id: 'theme',
        label: resolved === 'dark' ? 'Switch to sepia light' : 'Switch to dark',
        icon: resolved === 'dark' ? Sun : Moon,
        run: () => setTheme(resolved === 'dark' ? 'light' : 'dark'),
      },
      {
        id: 'delete',
        label: 'Delete document',
        icon: Trash2,
        keywords: 'remove destroy',
        run: () => setDeleting(true),
      },
    ],
    [clearHighlights, doc.filename, downloadUrl, reindex, resolved, router, setTheme],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;

      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (meta && event.key === '/') {
        event.preventDefault();
        setTab('chat');
        composer.current?.focus();
        return;
      }
      if (meta && event.key.toLowerCase() === 'f') {
        // The browser's own find works on the rendered pages; ours works on all
        // of them. In a virtualized viewer that is not a close call.
        event.preventDefault();
        setTab('document');
        viewer.current?.openSearch();
        return;
      }
      if (event.key === 'Escape' && !paletteOpen && !renaming && !deleting) {
        clearHighlights();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearHighlights, paletteOpen, renaming, deleting]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const stage = live?.stage;
  // Openable rather than finished. A `partially_ready` document has pages,
  // geometry, chunks and vectors for everything read so far — so the viewer
  // opens on page one and chat answers over the indexed part while the rest is
  // still being read, which is the whole point of Phase 12.4's partial
  // readiness. Holding a 900-page filing behind a spinner for fifteen minutes
  // when the answer is on page four is the failure it exists to remove.
  const readable = readableStatus(doc.status);
  const terminal =
    stage !== undefined
      ? stage === 'ready' || stage === 'failed' || stage === 'cancelled'
      : doc.status === 'failed' || doc.status === 'cancelled';
  const isProcessing = !readable && !terminal;
  // Shown *over* an open document rather than instead of it: a reader browsing
  // the pages that are ready is entitled to know the rest is still coming, and
  // to be able to stop it, without losing the document they are reading.
  const stillIndexing = doc.status === 'partially_ready';

  const viewerPane = isProcessing ? (
    <WorkspaceProcessingView
      filename={doc.filename}
      document={doc}
      live={live}
      onChanged={refresh}
    />
  ) : (
    <div className="flex h-full min-h-0 flex-col">
      {stillIndexing ? <IndexingBanner document={doc} progress={live} onChanged={refresh} /> : null}
      <Viewer
        url={viewUrl}
        pages={pages}
        filename={doc.filename}
        downloadUrl={downloadUrl}
        handleRef={viewer}
        className="min-h-0 flex-1"
      />
    </div>
  );

  const chatPane = (
    <ChatPane
      document={doc}
      initialMessages={initialMessages}
      conversationId={conversationId}
      onCitationSelect={onCitationSelect}
      activeCitationId={activeCitationId}
      composerRef={composer}
      live={live}
    />
  );

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-3 py-2">
        <Link
          href="/documents"
          aria-label="Back to library"
          className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-foreground-muted hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-4" />
        </Link>

        <FileText aria-hidden className="size-4 shrink-0 text-foreground-subtle" />

        <div className="min-w-0 flex-1">
          <h1 className="truncate font-serif text-[18px] leading-tight" title={doc.filename}>
            {doc.filename}
          </h1>
          <p className="mt-0.5 flex items-center gap-3 text-[13px] text-foreground-subtle">
            <DocumentStatus
              status={doc.status}
              {...(live ? { stage: live.stage, percent: live.percent } : {})}
              showProgressBar
            />
            {doc.pageCount ? <span>{doc.pageCount} pages</span> : null}
          </p>
        </div>

        <div className="hidden items-center gap-2 sm:flex">
          <ThemeToggle />
        </div>

        <IconButton
          variant="tertiary"
          icon={Search}
          label="Commands (⌘K)"
          onClick={() => setPaletteOpen(true)}
        />

        <Menu
          label={`Actions for ${doc.filename}`}
          items={[
            {
              label: 'Rename',
              icon: Pencil,
              onSelect: () => {
                setRenameDraft(doc.filename);
                setRenaming(true);
              },
            },
            {
              label: 'Download original',
              icon: Download,
              onSelect: () => window.open(downloadUrl, '_blank', 'noopener'),
            },
            { label: 'Re-index', icon: RefreshCw, onSelect: () => void reindex() },
            { label: 'Delete', icon: Trash2, destructive: true, onSelect: () => setDeleting(true) },
          ]}
          trigger={(props) => (
            <Button {...props} variant="tertiary" size="icon" aria-label="Document actions">
              <span aria-hidden className="text-[18px] leading-none">
                ⋯
              </span>
            </Button>
          )}
        />
      </header>

      <div
        role="tablist"
        aria-label="Workspace"
        className="flex shrink-0 border-b border-border-subtle min-[900px]:hidden"
      >
        {(['chat', 'document'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`panel-${value}`}
            onClick={() => setTab(value)}
            className={cn(
              'flex-1 cursor-pointer border-b-2 px-4 py-2.5 text-[15px]',
              tab === value
                ? 'border-accent text-foreground'
                : 'border-transparent text-foreground-muted',
            )}
          >
            {value === 'chat' ? 'Chat' : 'Document'}
          </button>
        ))}
      </div>

      {/*
        The viewer and chat panels stay mounted continuously in a single tree.
        Switching between mobile tabs and wide-screen split layout happens via CSS,
        preventing PDF.js document teardown and re-fetching on desktop load or resize.
      */}
      <SplitPane
        className="min-h-0 flex-1"
        label="Resize the document and chat panes"
        fraction={split}
        onFraction={setSplit}
        leftClassName={cn(
          'min-h-0 flex-col',
          tab === 'document' ? 'flex flex-1' : 'hidden',
          'min-[900px]:flex min-[900px]:flex-none min-[900px]:w-[var(--split-fraction)]',
        )}
        rightClassName={cn(
          'min-h-0 flex-col',
          tab === 'chat' ? 'flex flex-1' : 'hidden',
          'min-[900px]:flex min-[900px]:flex-1',
        )}
        left={
          <div
            role="tabpanel"
            id="panel-document"
            aria-labelledby="tab-document"
            className="flex h-full min-h-0 flex-col"
          >
            {viewerPane}
          </div>
        }
        right={
          <div
            role="tabpanel"
            id="panel-chat"
            aria-labelledby="tab-chat"
            className="flex h-full min-h-0 flex-col"
          >
            {chatPane}
          </div>
        }
      />

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />

      <Dialog
        open={renaming}
        onClose={() => setRenaming(false)}
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
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Delete this document?"
        description={`“${doc.filename}”, its pages, its passages and its file are removed. This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => void remove()}
        busy={busy}
      />
    </div>
  );
}

function WorkspaceProcessingView({
  filename,
  document,
  live,
  onChanged,
}: {
  filename: string;
  document: DocumentView;
  live?: DocumentProgress | undefined;
  onChanged?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center p-8">
      <div className="mx-auto flex w-full max-w-md flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h2 className="font-serif text-[20px] leading-snug text-foreground">
            Reading “{filename}”
          </h2>
          <p className="text-[14px] leading-relaxed text-foreground-muted">
            Konusbitr is reading pages and indexing passages for search and answers. This screen
            opens the document as soon as the first pages are ready.
          </p>
        </div>

        <IngestionPanel document={document} progress={live} onChanged={onChanged} />
      </div>
    </div>
  );
}

function IndexingBanner({
  document,
  progress,
  onChanged,
}: {
  document: DocumentView;
  progress?: DocumentProgress | undefined;
  onChanged?: () => void;
}) {
  const [stopping, setStopping] = useState(false);
  const ready = progress?.pagesReady ?? document.pagesReady ?? 0;
  const total = progress?.pagesTotal ?? document.pagesTotal ?? 0;

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
    <div
      // Unobtrusive by construction: a line of text on the page's own ground
      // rather than a coloured bar. The document is what the reader came for
      // and this is a footnote about it, so it takes one row, keeps the
      // viewer's full height underneath, and says nothing in colour that it
      // does not also say in words.
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-subtle px-3 py-2 text-[13px] text-foreground-muted"
      aria-live="polite"
    >
      <Loader aria-hidden className="size-3.5 shrink-0" />
      <span>
        {total > 0
          ? `Indexing in progress: ${ready} of ${total} pages processed.`
          : 'Indexing in progress.'}{' '}
        You can search and chat with the pages that are ready.
      </span>
      {progress?.etaSeconds !== undefined ? (
        <span className="tabular-nums">{formatEta(progress.etaSeconds)} left</span>
      ) : null}
      <Button variant="tertiary" size="sm" onClick={cancel} disabled={stopping} className="ml-auto">
        {stopping ? 'Stopping' : 'Cancel'}
      </Button>
    </div>
  );
}
