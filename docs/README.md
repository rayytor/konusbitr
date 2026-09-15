# Konusbitr docs

Source for the documentation site, the architecture decision records, and the
reference documents the codebase points at:

- `coordinates.md` — the one coordinate convention (PDF points, origin
  top-left, y increasing downward, unrotated page).
- `chunking.md` — the rules a retrievable passage is built by, and the two
  places where the acceptance criteria pull against each other.
- `licensing.md` — which dependencies are in the default Apache-2.0-clean build
  and which live behind the Compose `advanced` profile.

Placeholder until **Phase 15**; individual documents arrive earlier, with the
phase that makes them load-bearing.

## Architecture decision records

Written when a decision is load-bearing and its alternatives were real —
not for every choice. An ADR is a record of what was decided and why, and of
the conditions under which it should be revisited; it is not amended when the
decision changes, it is superseded.

- [`adr/0001-queue.md`](adr/0001-queue.md) — the TypeScript ↔ Python job
  transport is a Redis stream with a consumer group, rather than BullMQ or
  arq. Phase 06.
- [`adr/0002-model-router.md`](adr/0002-model-router.md) — every model call goes
  through LiteLLM (worker) or `packages/ai` (product surface), never a provider
  SDK, with the four roles configured independently. Phase 08.
- [`adr/0003-retrieval.md`](adr/0003-retrieval.md) — fusion is RRF over ranks
  rather than normalized scores, the sparse leg ORs its terms and drops function
  words first, and `hnsw.ef_search` is set with `SET LOCAL` inside the query's
  own transaction. Phase 09.
- [`adr/0004-viewer.md`](adr/0004-viewer.md) — how the viewer renders a page and
  draws a citation on it, applying a scale factor and nothing else. Phase 11.
- [`adr/0005-ocr.md`](adr/0005-ocr.md) — pages are tiered individually, and the
  OCR engines are driven directly rather than through Docling, because per-page
  confidence, the deskew transform and word boxes do not survive its text-cell
  abstraction. Phase 12.1.
- [`adr/0006-multilingual-tables-figures.md`](adr/0006-multilingual-tables-figures.md)
  — the language route is a per-document decision and the reading direction a
  per-line one; both image preparations are read when an engine wants both; a
  scanned table is reconstructed from its ruling lines; figures are extracted
  always and captioned only on request. Phase 12.2.
