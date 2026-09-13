# ADR 0004 — A thin viewer over PDF.js, not a wrapper library

**Status:** accepted (Phase 11)

## Context

The product is a citation you can click. An answer says something, names a
page, and clicking it has to scroll that page into view and draw a rectangle
around the sentence the claim came from. Everything in Phases 05–10 exists to
make that rectangle correct; Phase 11 is what makes it visible.

There are three ways to put a PDF on a page in 2026:

1. `<iframe src="…#page=42">`, letting the browser's built-in viewer render it.
2. A React wrapper around PDF.js — `react-pdf`, `@react-pdf-viewer/core`, and
   several commercial equivalents.
3. PDF.js directly, with our own render loop.

## Decision

**PDF.js directly.**

The iframe is out immediately: a cross-origin document viewer gives us no access
to the page's geometry, no way to draw a highlight on it, and no control over
what happens when the reader scrolls. `#page=42` is the whole API.

The wrapper libraries are the real alternative, and the reason they lose is
narrower than "we wanted control". They all own the canvas and the text layer,
and expose highlighting either as a plugin with its own coordinate model or not
at all. Konusbitr has exactly one coordinate convention — PDF user-space points,
origin top-left, y down, unrotated page, fixed in the worker and documented in
`docs/coordinates.md` — and the viewer's entire job is to multiply it by a
scale factor. Handing that multiplication to a plugin that thinks in
percentages, or in PDF's own bottom-left origin, means either converting into
its model (a second convention, undocumented, in the layer furthest from the
worker that produced the numbers) or fighting it.

The bet the convention makes is that the viewer stays trivial. A wrapper makes
the viewer non-trivial in exactly the place the convention says it must not be.

## What this costs, and what it buys

It costs a render loop: page virtualization, canvas reuse, cancelling in-flight
renders on zoom, and a text layer that has to be laid out from PDF.js's own
primitives. That is about four hundred lines in
`apps/web/src/components/viewer/`, and it is four hundred lines we now own.

It buys three things that are not optional here:

- **The highlight sits between the canvas and the text layer**, composited with
  `multiply`. A cited sentence reads as ink on amber rather than as a
  translucent box over the words — which is what `design.md` §7 asks for, and
  also the only arrangement in which the reader can still read the quote they
  clicked to check.
- **Page geometry comes from the database, not from PDF.js.** The `pages` table
  already holds every page's width and height, so the scroll container has its
  true height on the first frame, before a single page has been fetched. A
  500-page document whose scrollbar grows as pages load is unusable: every
  scroll lands somewhere other than where it was aimed. No wrapper can do this,
  because no wrapper knows about our database.
- **Byte-range loading is ours to configure.** A 256KiB range chunk means a
  500-page document opens in about the time it takes to fetch its first page,
  straight from object storage, without the app server touching the bytes.
  `disableAutoFetch` is the tempting companion setting and is deliberately left
  off: it stops PDF.js pulling the rest of the file in the background, so on an
  image-heavy document every image `page.render()` reaches for becomes a cold
  range request served one at a time. Measured on a 173MB/240-page document,
  rasterising page one took 25,620ms with it and 189ms without, for identical
  worker-side parse time — and raising the chunk size to 1MiB made it worse
  (59,501ms), because the cost is round trips rather than bytes. The viewer
  renders a window of pages at once, so the loss was large enough that Chrome's
  renderer watchdog killed the tab (`FATAL:child_thread_impl.cc "Crashing
  because hung"`, surfaced to the reader as an "Aw, Snap!" page reporting
  `SIGILL`).

## Consequences

- PDF.js's runtime data — character maps, standard font metrics, the WASM image
  decoders — is copied into `public/pdfjs` at build time by
  `scripts/copy-pdfjs-assets.mjs` rather than loaded from a CDN. A
  self-hostable, privacy-first document tool that makes a third-party request
  the first time somebody opens a Japanese PDF is not self-hosted, and on an
  air-gapped instance it simply fails to render.
- A subset of `pdfjs-dist/web/pdf_viewer.css` is vendored into `globals.css`
  for the text layer. PDF.js writes `--font-height`, `--scale-x` and `--rotate`
  onto each span and expects a stylesheet to turn them into a font size and a
  transform. Importing the whole viewer stylesheet would bring the default
  toolbar, sidebar and annotation chrome, none of which this product uses and
  all of which would fight the sepia theme.
- Upgrading `pdfjs-dist` across a major version is now our problem rather than a
  wrapper maintainer's. The surface we touch is small and stable —
  `getDocument`, `getPage`, `getViewport`, `render`, `TextLayer`,
  `Util.applyTransform` — and `apps/web/e2e/citation.spec.ts` asserts the
  highlight lands within two pixels of its stored bounding box, so a change in
  any of them fails a test rather than shipping a viewer that is subtly wrong.

## When to revisit

If PDF.js ships a supported, coordinate-explicit highlight layer, the custom
layer becomes worth deleting. The render loop and the database-driven layout
should stay regardless; neither is something a general-purpose viewer can
provide.
