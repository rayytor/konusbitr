# Konusbitr v0.1.0

**The product works.** Upload a PDF, ask a question, and every claim in the
answer carries the page it came from. Click the page reference and the viewer
scrolls there and highlights the exact passage the claim was drawn from.

That one interaction is what this release is for. Everything underneath it —
the parse, the chunker, the hybrid retrieval, the citation verifier — has
existed for a while and has been invisible.

This is the first tagged release, and it covers phases 01 to 13 of the plan in
[`phases/`](./phases). The viewer and the chat were finished at Phase 11 and
these notes were first written then, but nothing was tagged; the tag was cut
after Phases 12 and 13, so `v0.1.0` also reads scans and serves the public API.
Both are described below.

```bash
git clone https://github.com/rayytor/konusbitr
cd konusbitr
git checkout v0.1.0
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

**Scans are read.** Every page is classified by how much text it actually
carries: Docling reads the born-digital ones and a CPU OCR stack — RapidOCR,
with Tesseract as a fallback — reads the rest, so a filing that is seven
digital pages and three photocopies is read by both. Pages are deskewed before
recognition and the transform is undone before a box is stored, so a citation
into a scan lands where a citation into a digital page would. A document is
routed by language before it is read, reading direction is decided per line, a
ruled table on a scanned page is rebuilt from its own ruling lines, and figures
are extracted from every document. A document nothing can read is still refused
with `needs_ocr` rather than answered from silence.

**A vision tier that is not trusted with the characters.** With a vision model
configured, `quality: "advanced"` reads each page by looking at it and returns
blocks in reading order — the thing a three-column page needs and neither
Docling nor a recogniser can supply. Every character the model wrote is then
replaced with the verbatim text from the page's own text layer or from the
confidently recognised OCR words. The cost is quoted before upload, a document
past `MAX_VLM_PAGES_PER_JOB` is refused rather than truncated, and an
organization can be given a monthly ceiling.

**Long documents survive.** A document is read, chunked, embedded and committed
a batch of pages at a time. A worker killed at page 850 resumes at 851; the
viewer opens and chat answers over the pages already indexed while the rest is
still being read; a job can be cancelled, leaving a short document rather than
a broken one, and retried at different settings.

**The public API.** `/v2/parse`, `/v2/extract`, `/v2/split` and `/v2/ask`,
authenticated with `X-API-Key` and wire-compatible with `api.pdf.ai/v2` —
[`docs/api-compatibility.md`](docs/api-compatibility.md) is the field-by-field
account, and a test holds the schemas to it. Long-running endpoints have an
`?async=true` twin with a signed webhook. `extract` returns a value only when
its supporting quote is verifiably in the document. Every call is a row in a
credit ledger, which records and never refuses unless `CREDITS_MODE=metered`.
The OpenAPI 3.1 document at [`docs/openapi.json`](docs/openapi.json) is
generated from the route table, and the TypeScript and Python clients in
[`packages/sdk`](packages/sdk) and [`sdks/python`](sdks/python) are generated
from it.

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

- **The SDKs are not on npm or PyPI yet.** Both are built, packed, installed
  from the pack and run against a live stack in CI, but neither has been
  published, so `npm install @konusbitr/sdk` and `pip install konusbitr` do not
  work today. `KONUSBITR_API_KEY=… ./scripts/sdk-quickstart.sh` builds, packs
  and installs both from this repository and runs their quickstarts;
  `.github/workflows/release-sdks.yml` publishes them when it is run.
- **A scanned table with no ruling lines is read as prose**, and a scan has no
  headings unless the vision tier reads it — the OCR tier has no layout model.
- **The vision tier and figure captions need a vision model**, which the default
  `.env` does not name. Without `VISION_PROVIDER` and `VISION_MODEL`,
  `quality: "advanced"` is refused, and figures are stored and located but not
  described.
- **Regenerating or editing a question** removes the replaced turn from the
  visible transcript but leaves it in the conversation's stored history; there
  is no message-deletion endpoint yet.
- **The endpoints under `/api` are the application's own** and are not a stable
  contract. `/v2` is.
- **Not built yet:** folders, library search, chat across every document,
  summaries and sharing (Phase 14); the browser extension, deploy templates and
  the docs site (Phase 15).
- **With no embedding model configured**, retrieval is keyword-only. That is a
  supported state; `POST /api/documents/:id/reindex` fills the vectors in once a
  model is named.

## Licence

Apache-2.0. The default build stays cleanly Apache-2.0 compatible; the
restrictively licensed parser extras live behind the optional `advanced` Compose
profile and are not built by default.
