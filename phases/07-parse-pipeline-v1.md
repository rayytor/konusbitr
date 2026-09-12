# Phase 07 — Parse Pipeline v1 (Docling → Markdown + Bounding Boxes)

**Goal:** turn a born-digital text PDF into Markdown plus a structured contents
array carrying **page numbers and bounding boxes** for every element. This is the
foundation of Konusbitr's citation feature — everything downstream depends on the
fidelity of what this phase produces.

## Context

Citations are the product. An answer the user cannot verify by clicking through
to the exact spot on the exact page is worth little, and a wrong highlight is
worse than none. **Docling** (IBM, MIT-licensed) is the primary parser precisely
because it emits layout-aware structure with first-class bounding boxes and
reading order. Scanned documents, OCR, and the VLM `advanced` path are Phase 12 —
this phase handles text PDFs only and fails cleanly on anything else.

## Scope

### 1. Replace the stub `parse` handler

Pipeline stages inside `services/worker/src/konusbitr_worker/parse/`:

1. **Fetch** the object from storage to a temp path; verify the SHA-256 matches
   `contentHash`.
2. **Validate** — page count, encryption, corruption. Terminal-fail with a clear
   `error_code` on anything unhandled.
3. **Text-layer detection** — compute extractable-character coverage per page.
   If coverage is below `TEXT_COVERAGE_THRESHOLD` (default 0.1) on more than 20%
   of pages, fail with `error_code: "needs_ocr"` and a message saying OCR support
   arrives with the `advanced` pipeline. Do not silently return garbage.
4. **Docling parse** — full document conversion, preserving reading order,
   headings hierarchy, tables, lists, and figures.
5. **Normalize** to the Konusbitr parse artifact (below).
6. **Persist** `parse_results`, `pages`, and page thumbnails (WebP, longest edge
   1600px) to storage.

### 2. The parse artifact

```jsonc
{
  "markdown": "# Title\n\n…",
  "pageCount": 42,
  "contents": [
    {
      "id": "el_0007",
      "type": "heading" | "paragraph" | "table" | "list" | "figure" | "caption" | "footnote",
      "level": 2,                       // headings only
      "text": "Revenue grew 18% year over year.",
      "markdown": "…",                  // element-scoped markdown (tables especially)
      "page": 42,
      "bbox": [72.0, 310.5, 523.4, 328.9],
      "sectionPath": ["Financials", "Revenue"],
      "tableJson": { "headers": [...], "rows": [...] }   // tables only
    }
  ],
  "images": []                          // populated in Phase 12
}
```

**Coordinate system, stated once and obeyed everywhere:** PDF user-space points,
origin **top-left**, y increasing downward, unrotated page. Normalize Docling's
output into this convention in the worker, apply page rotation there, and store
page `width`/`height` alongside. The viewer (Phase 11) then needs only a scale
factor. Write this into `docs/coordinates.md` and add a unit test on a fixture
page with known element positions — including a rotated page and a non-Letter
page size.

### 3. Table handling

Tables are preserved **twice**: as Markdown inside the document markdown (so the
LLM can read them in context) and as JSON in `tableJson` (so Phase 13's `extract`
can pull individual cells). A table element is never split across `contents`
entries.

### 4. Parallelism and budget

Parse pages in parallel where Docling allows, with a bounded pool. Budget:
**a 50-page text PDF reaches `ready` in under 20 seconds** on a 4-core machine.
Instrument per-stage timings and log them; add a CI performance check that fails
if the fixture regresses by more than 50%.

### 5. Fixture corpus

Commit a small fixture set under `fixtures/` (public-domain or self-generated
only — never copyrighted material):

- a clean 10-page text PDF
- a table-heavy financial report
- a two-column academic paper
- a rotated-page document
- a 500-page monster (generated)
- a malformed PDF and an encrypted PDF (both must fail cleanly)

### 6. Tests

- Golden-file tests: parsing each fixture produces markdown matching a committed
  snapshot (normalized for whitespace).
- Bbox tests: assert known elements land within tolerance of expected coordinates.
- Failure tests: each bad fixture yields the expected `error_code` and never hangs.

## Non-goals

OCR, scanned documents, VLM captioning, image extraction, DOCX/PPTX — all Phase 12
or later. Chunking and embedding — Phase 08.

## Acceptance criteria

- [x] Each good fixture parses to markdown that a human would call faithful
      (headings, reading order, and tables correct).
- [x] Every `contents` element has a page number and a bbox in the documented
      top-left convention, verified against the rotated and non-Letter fixtures.
- [x] Tables appear both as markdown and as `tableJson`.
- [x] The 50-page text fixture completes in under 20 seconds in CI.
- [x] Scanned, encrypted, and corrupt inputs fail with distinct `error_code`s and
      user-readable messages.
- [x] Page thumbnails exist in storage for every page.
- [x] `docs/coordinates.md` exists and the coordinate test suite passes.
