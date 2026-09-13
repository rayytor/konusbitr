# Phase 11 — PDF Viewer, Chat UI, and the MVP Ship

**Goal:** the product. Side-by-side PDF viewer and chat, where clicking a citation
scrolls to the page and highlights the exact region the answer came from.

> **This is the milestone.** Ship when a user can upload a text PDF and get a
> cited answer they can click through to. Everything after this phase is breadth.

## Context

Phases 05–10 built a correct pipeline nobody can see. The citation highlight is
the moment Konusbitr earns trust — the user asks, gets an answer, clicks, and
watches the source light up on the page. Everything in this phase serves that
moment.

## Scope

### 1. The viewer (`apps/web/components/viewer`)

A thin custom viewer over **PDF.js (`pdfjs-dist`)**, not a wrapper library — we
need low-level control of the text and canvas layers to draw highlights from
bounding boxes.

- Continuous vertical scroll, page virtualization (render a window of pages only),
  zoom (fit-width, fit-page, ±, pinch), page navigation, rotation.
- Text layer enabled for native selection and in-document search (`Ctrl+F`).
- A **highlight layer** per page: absolutely-positioned rectangles derived from
  `Citation.bbox`, converted from the Phase 07 top-left PDF-point convention into
  viewport pixels via PDF.js's viewport transform at the current scale and rotation.
  Because the convention was fixed in Phase 07, this is a scale multiply — if it
  isn't, fix the worker, not the viewer.
- `scrollToCitation(citation)` — scroll the page into view, flash the highlight,
  leave it persistently marked until dismissed.
- Render 500+ page documents without jank; lazy-load pages, reuse canvases.

### 2. The chat pane

- Vercel AI SDK `useChat` against Phase 10's endpoint, streaming markdown with
  code blocks and tables rendered properly.
- **Citation chips** inline or beneath each paragraph, labeled `p. 42`. Hover
  previews the quote; click calls `scrollToCitation`.
- Stage indicator while retrieving; stop, regenerate, copy, and edit-last-message.
- Suggested starter questions generated from the document summary.
- Empty, loading, error, and "document still processing" states — all four,
  properly designed, not afterthoughts.

### 3. The document workspace

`/documents/[id]` — a resizable split pane (viewer left, chat right), collapsing
to tabs on mobile. Keyboard shortcuts: `⌘K` command palette, `⌘/` focus chat,
`Esc` clear highlight. Persist pane size per user.

### 4. The library

`/documents` — grid and list views with page-1 thumbnails, status badges driven
by the Phase 06 SSE stream, drag-and-drop upload with per-file progress, rename,
delete with confirmation, sort and filter. TanStack Table + Virtual for large
libraries.

### 5. Design system and polish

- Tailwind v4 + shadcn/ui, a coherent color scale, dark mode that actually works
  (including the PDF canvas — dim the page, never invert it).
- Responsive down to 375px.
- **Accessibility is a requirement, not a nice-to-have**: keyboard-navigable
  everything, focus rings, ARIA live regions for streaming answers, and citation
  chips reachable by keyboard with the highlight announced to screen readers.
- Skeletons, optimistic updates, and toasts for every mutation.

### 6. End-to-end tests

Playwright: sign up → upload a fixture → wait for `ready` → ask a question →
assert an answer streams → click a citation → **assert the viewer scrolled to the
expected page and a highlight rectangle exists within tolerance of the expected
coordinates**. This test is the product's smoke test; it runs on every PR.

### 7. Ship it

Tag `v0.1.0`. Write the README quickstart for real (three commands to a working
instance), record a 60-second demo GIF of the citation click-through, and publish
the first release notes. A self-hoster who finds the repo must be able to get to
a cited answer in under ten minutes.

## Acceptance criteria

- [x] Upload → ready → ask → cited answer → click → correct page scrolled and the
      correct region highlighted, on every good fixture.
- [x] The Playwright citation E2E test passes in CI.
- [x] A 500-page document scrolls and renders without visible jank.
- [x] Dark mode, mobile (375px), and full keyboard navigation all work.
- [x] Axe reports no critical accessibility violations on the workspace and library.
- [x] A fresh clone reaches a cited answer in under ten minutes following the README.
- [x] `v0.1.0` is tagged with release notes and a demo GIF.
