# Phase 14 — Product Surface: Library, Corpus Chat, Sharing, Teams

**Goal:** close the remaining gap between Konusbitr and PDF.ai's consumer app —
organization, cross-document chat, summarization, sharing, and the settings that
make bring-your-own-model real.

## Context

Phase 11 shipped one document at a time. Real users accumulate hundreds of
documents and expect to organize them, search across them, and ask questions that
span them. Phase 09 already built corpus retrieval; this phase gives it a product.

## Scope

### 1. Folders and organization

- Nested folders with drag-and-drop, breadcrumbs, move, rename, delete
  (with a clear prompt about what happens to contained documents).
- Bulk selection: multi-move, multi-delete, multi-download.
- Tags as a flat cross-cutting alternative to folders, filterable.

### 2. Library search

Search across the org's documents by filename, content (the `tsv` index), tag, and
folder. Instant results with snippet highlighting and a jump-to-page link that
opens the viewer already scrolled. Filters: date range, page count, status, type.

### 3. Chat with all PDFs

The corpus mode from Phase 09, surfaced:

- A `/chat` route not bound to any single document, with a scope selector:
  everything, a folder, a tag, or a hand-picked set.
- Answers **group citations by document**; each citation shows the document name
  and page and opens that document's viewer at the highlighted region.
- A source panel listing which documents contributed, so the user can see the
  answer's footprint.
- Honest empty and partial states: say when a scope is too large for a single pass
  and what the two-stage retrieval did instead.

### 4. Summarization presets

- Whole-document summary, generated at ingest (already needed by Phase 09's
  two-stage retrieval) and shown on the document page.
- On-demand presets: executive summary, key points, action items, per-section
  outline, and a custom prompt. Each streams and carries citations.
- Summaries are cached per `(documentId, preset, model)` and invalidated on reindex.

### 5. Export and sharing

- Export a conversation to Markdown or PDF, citations preserved as page references.
- **Share links** for a conversation or a document: opt-in, revocable, optionally
  password-protected and expiring. A shared link is read-only and must **not**
  expose the org, other documents, or the API key — write an explicit test for
  each of those leaks.
- Export a document's parse result as Markdown or JSON.

### 6. Settings

- **Models**: choose chat, embedding, rerank, and vision models per org, with
  bring-your-own API keys stored encrypted at rest (envelope encryption with a
  key from env — document the key-rotation path). Local/Ollama presets one click away.
- Changing the embedding model prompts a reindex and explains the cost.
- Defaults for parse quality, OCR languages, and `llm` captioning.
- Usage dashboard: documents, pages processed, tokens, and cost over time, from the
  credit ledger — valuable even with `CREDITS_MODE=unlimited`.
- Data controls: export everything, delete everything, and a retention policy.

### 7. Teams

Build on Phase 04's roles: shared org library, per-document visibility
(private-to-uploader or org-wide), activity feed of uploads and shares, and
member management UI.

## Acceptance criteria

- [ ] Folders, tags, bulk operations, and library search all work on a 1,000-document
      seeded library without perceptible lag.
- [ ] A corpus question returns an answer citing multiple documents, and each
      citation opens the right document at the right highlighted region.
- [ ] Corpus answers never draw more than 3 chunks from one document (Phase 09 cap
      holds end-to-end).
- [ ] Each summarization preset streams with working citations and is cached.
- [ ] A share link opens read-only for a logged-out visitor; revoking it 404s;
      tests prove it exposes no other org data and no keys.
- [ ] Conversation export to Markdown and PDF preserves citations as page references.
- [ ] An org can switch to a fully local model set from the settings UI and chat
      continues to work end-to-end.
- [ ] BYO API keys are encrypted at rest and never appear in logs or API responses.
- [ ] The usage dashboard reconciles exactly with the credit ledger.
