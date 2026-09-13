import { scopedDb } from '@konusbitr/db';
import type { Metadata } from 'next';
import { AppShell } from '@/components/app-shell';
import { LibraryView } from '@/components/library/library-view';
import { requireSession } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { presentDocument } from '@/lib/ingest/documents';

/**
 * `/documents` — the library.
 *
 * Rendered on the server with the first page of documents already in it, so
 * there is no empty flash and no client fetch on load. Everything after that —
 * uploading, importing, renaming, deleting — happens in the client component.
 */
export const metadata: Metadata = { title: 'Library — Konusbitr' };

const FIRST_PAGE = 500;

export default async function LibraryPage() {
  const session = await requireSession('/documents');
  const rows = await scopedDb(db(), session.orgId).listDocuments({ limit: FIRST_PAGE });

  return (
    <AppShell session={session}>
      <LibraryView initialDocuments={rows.map((row) => presentDocument(row))} />
    </AppShell>
  );
}

export const dynamic = 'force-dynamic';
