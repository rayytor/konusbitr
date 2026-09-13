# Konusbitr v0.1.0

**The product works.** Upload a PDF, ask a question, and every claim in the
answer carries the page it came from. Click the page reference and the viewer
scrolls there and highlights the exact passage the claim was drawn from.

That one interaction is what this release is for. Everything underneath it —
the parse, the chunker, the hybrid retrieval, the citation verifier — has
existed for a while and has been invisible.

```bash
git clone https://github.com/konusbitr/konusbitr
cd konusbitr
cp .env.example .env && docker compose up
```

Then follow **From zero to a cited answer** in the README. No API key is needed
to upload and read a document; a chat model is needed to ask it questions, and
`docker compose --profile local-llm up` supplies one that costs nothing and
sends nothing anywhere.

## What is new

**A PDF viewer built for citations.** Continuous scroll with page
virtualization, fit-width and fit-page, zoom by control or by trackpad pinch,
rotation, and find-in-document that searches pages nobody has scrolled to yet.
The highlight sits *between* the canvas and the text layer and composites with
`multiply`, so a cited sentence reads as ink on amber rather than as a box laid
over the words — which is also the only arrangement in which you can still read
the quote you clicked to check.

**A chat pane that shows its working.** Answers stream as markdown with tables
and code rendered properly. Each claim ends in a `p. 42` chip: hover it for the
verified quote, click it for the passage on the page. A citation whose quote
could not be found in the document never becomes a chip at all — the server
drops it before the browser sees it. Stop, regenerate, copy, edit the last
question, and starter questions generated from the document's own abstract.

**A workspace.** `/documents/:id` is a resizable split — document left, chat
right — that remembers where you put the divider and collapses to two tabs
below 900px rather than cramming three columns onto a phone. `⌘K` opens a
command palette, `⌘/` jumps to the composer, `⌘F` searches the document, and
`Esc` clears the highlights.

**A library.** `/documents` in a spacious list or a compact grid, with page-one
thumbnails, live status from the parse pipeline, drag-and-drop upload with real
per-file progress, rename, delete with confirmation, sorting and filtering.
Virtualized, so a library of four thousand documents scrolls like a library of
four.

**Dark mode that understands paper.** The page is *dimmed*, never inverted — an
inverted scan is unreadable and an inverted photograph misrepresents the
document. The theme applies before first paint, so there is no flash.

## Also in this release

- `PATCH /api/documents/:id` renames a document; `GET …/pages`,
  `GET …/thumbnail?page=n`, `GET …/file` and `GET …/suggestions` are new.
- `S3_PUBLIC_ENDPOINT` fixes presigned URLs under Compose. The web container
  reaches storage at `minio:9000`, your browser cannot, and SigV4 signs the
  `Host` header — so browser-facing URLs are now signed against an origin the
  browser can actually use. Without it the viewer could not fetch a document in
  a Compose deployment at all.
- Signing in now lands on the library rather than on the API keys page.
- `/library` permanently redirects to `/documents`.
- `pnpm dev` exports the repository's `.env` rather than leaving Next.js and the
  worker to find it themselves, which they did not.

## Accessibility

Keyboard-navigable throughout, including the resize divider (arrow keys), the
command palette (a real combobox with `aria-activedescendant`), and every
citation chip. Streaming answers are announced through a polite live region, and
focusing a citation announces the page and the quote. Status is never
communicated by colour alone. Axe reports no critical or serious violations on
the library or the workspace, asserted in CI.

## Testing

`apps/web/e2e/citation.spec.ts` is the product's smoke test and runs on every
pull request: sign up, upload a fixture, wait for `ready`, ask a question,
assert an answer streams, click the citation — and assert the highlight
rectangle lands **within two pixels** of where the stored bounding box says it
belongs.

Only the chat model is stubbed, by a server that quotes the first retrieved
passage back verbatim so the citation is deterministic. Retrieval, verification,
the parse geometry and the viewer are all the real thing; if the worker ever
writes a flipped bounding box, this test fails.

## Known limits

- **Scanned documents are refused, not parsed.** A page with no text layer is
  rejected with `needs_ocr` rather than answered from silence. OCR arrives in
  Phase 12.
- **Regenerating or editing a question** removes the replaced turn from the
  visible transcript but leaves it in the conversation's stored history; there
  is no message-deletion endpoint yet.
- **The public `/v2` API** is Phase 13. The endpoints under `/api` are the
  application's own and are not a stable contract.
- **With no embedding model configured**, retrieval is keyword-only. That is a
  supported state; `POST /api/documents/:id/reindex` fills the vectors in once a
  model is named.

## Licence

Apache-2.0. The default build stays cleanly Apache-2.0 compatible; the
restrictively licensed parser extras live behind the optional `advanced` Compose
profile and are not built by default.
