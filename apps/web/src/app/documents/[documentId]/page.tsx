import { scopedDb } from '@konusbitr/db';
import type { ChatMessageView } from '@konusbitr/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocumentWorkspace } from '@/components/workspace/document-workspace';
import { requireSession } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { presentDocument } from '@/lib/ingest/documents';
import { storage } from '@/lib/storage';

/**
 * `/documents/:id` — the workspace.
 *
 * Everything the first frame needs is resolved here, on the server: the
 * document row, its page geometry, a presigned URL to stream the PDF from, and
 * the most recent conversation about it with its messages. A workspace that
 * opens and *then* fetches four things shows four loading states before it
 * shows a document, and this is the screen a reader will spend their time on.
 */

type Params = { documentId: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { documentId } = await params;
  const session = await requireSession(`/documents/${documentId}`);
  const document = await scopedDb(db(), session.orgId).documentById(documentId);
  return { title: document ? `${document.filename} — Konusbitr` : 'Konusbitr' };
}

export default async function DocumentPage({ params }: { params: Promise<Params> }) {
  const { documentId } = await params;
  const session = await requireSession(`/documents/${documentId}`);
  const scoped = scopedDb(db(), session.orgId);

  const row = await scoped.documentById(documentId);
  // A document belonging to another organization is *absent*, not forbidden:
  // the same 404 for a foreign id and a nonexistent one is what stops an id
  // enumeration from being informative.
  if (!row) notFound();

  const store = storage();
  const [pageRows, viewUrl, downloadUrl, conversations] = await Promise.all([
    scoped.listPages(documentId),
    store.presignGet(row.storageKey, { expiresIn: 60 * 60, inlineAs: row.filename }),
    store.presignGet(row.storageKey, { expiresIn: 60 * 60, downloadAs: row.filename }),
    scoped.listConversations({ limit: 1, documentId }),
  ]);

  const conversation = conversations[0];
  const messages = conversation ? await scoped.messagesForConversation(conversation.id) : [];

  return (
    <DocumentWorkspace
      document={presentDocument(row)}
      pages={pageRows.map((page) => ({
        page: page.pageNo,
        width: page.width,
        height: page.height,
        // How the page was read, so the viewer can say so. A quote from a
        // recognised page and a quote from a born-digital one deserve different
        // amounts of trust, and nothing in the bounding boxes tells them apart.
        tier: page.tier,
        ocrConfidence: page.ocrConfidence,
      }))}
      viewUrl={viewUrl}
      downloadUrl={downloadUrl}
      conversationId={conversation?.id ?? null}
      initialMessages={messages.map(
        (message): ChatMessageView => ({
          id: message.id,
          conversationId: message.conversationId,
          role: message.role as ChatMessageView['role'],
          content: message.content,
          citations: (message.citations ?? []) as ChatMessageView['citations'],
          usage: message.usage as ChatMessageView['usage'],
          createdAt: message.createdAt.toISOString(),
        }),
      )}
    />
  );
}

export const dynamic = 'force-dynamic';
