import { scopedDb } from '@konusbitr/db';
import { LibraryShell } from '@/components/library/library-shell';
import { LibraryView } from '@/components/library/library-view';
import { requireSession } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { presentDocument } from '@/lib/ingest/documents';

/**
 * The library.
 *
 * Rendered on the server with the first page of documents already in it, so
 * there is no empty flash and no client fetch on load; everything after that —
 * uploading, importing, deleting — happens in the client component below.
 *
 * Phase 11 replaces this with the real three-column product surface. What it
 * has to be today is somewhere a person can actually put a document.
 */
const FIRST_PAGE = 50;

export default async function LibraryPage() {
  const session = await requireSession('/library');
  const rows = await scopedDb(db(), session.orgId).listDocuments({ limit: FIRST_PAGE });

  return (
    <LibraryShell
      session={session}
      title="Library"
      description="Upload a PDF and Konusbitr will read it. Uploading the same file twice costs nothing the second time."
    >
      <LibraryView initialDocuments={rows.map((row) => presentDocument(row))} />
    </LibraryShell>
  );
}

export const dynamic = 'force-dynamic';
