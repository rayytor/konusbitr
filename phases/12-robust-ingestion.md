# Phase 12 — Robust Ingestion: OCR, Languages, VLM, Images, Scale

**Goal:** make Konusbitr handle the documents people actually have — scans,
photos, multilingual contracts, image-heavy reports, and 900-page monsters —
instead of only the clean digital PDFs of Phase 07.

## Context

Phase 07 deliberately failed with `needs_ocr` on scanned input. That covers a
large share of real-world documents: signed contracts, government forms,
historical records, phone photos of receipts. This phase closes that gap with a
**tiered strategy** — always use the cheapest path that is good enough, and
surface confidence rather than silently returning garbage.

## Scope

### 1. The quality tiers

| Tier | Path | When |
|---|---|---|
| 1 | Native text layer (Docling, Phase 07) | Coverage above threshold |
| 2 | **OCR** — PaddleOCR primary, Tesseract fallback, Surya for hard layouts | Low text coverage |
| 3 | **VLM** — page images → structured markdown via the vision role | `quality: "advanced"`, or OCR confidence below threshold |

Tiering is **per page**, not per document: a mostly-digital PDF with three scanned
inserts OCRs only those three pages.

### 2. OCR

- PaddleOCR with `lang_list` from the parse settings; auto-detect language when
  the list is empty.
- Preprocessing: deskew, denoise, adaptive threshold, upscale low-DPI pages.
- OCR output must carry **word-level bounding boxes**, mapped into the Phase 07
  top-left coordinate convention. Citations must highlight just as precisely on a
  scanned page as on a digital one — this is the hard part; test it.
- Per-page confidence stored on `pages` and surfaced in the UI as a badge
  ("this page was read by OCR, confidence 0.72") so users know when to double-check.

### 3. The VLM `advanced` path

- Rasterize pages at a configurable DPI, send to the vision model through the
  router (GPT-4.1-class, Claude, Gemini, or local **Qwen2.5-VL**), request
  structured markdown plus element boxes.
- Reconcile VLM output with any available text layer; prefer the text layer for
  exact strings and the VLM for structure and reading order.
- Cost guardrails: page cap per request, an operator-configurable per-org limit,
  and a cost estimate shown in the UI before an `advanced` parse is launched.

### 4. Images and figures

- Extract embedded images; store under the Phase 05 key layout; populate the
  `images[]` array of the parse artifact (base64 for the API response, keys in the DB).
- With `llm: true`, caption figures via the vision model and index the captions as
  chunk text — so "the chart showing Q3 churn" becomes findable.

### 5. Scale and large documents

- Per-page parallelism with a bounded worker pool; chunked, resumable jobs so a
  900-page scan survives a worker restart.
- **Streamed partial readiness**: chat becomes available once the first N pages are
  embedded, with the UI stating that ingestion is still running.
- Memory ceilings per job; spill page images to disk rather than holding them.
- Budget: a 50-page scanned PDF reaches `ready` in **under 2 minutes on CPU OCR**.

### 6. Licensing discipline

**PyMuPDF is AGPL and Marker's license restricts commercial hosting.** Both go
behind the Compose `advanced` profile and a build flag. The default Konusbitr image
uses `pypdf` + `pdfplumber` + Docling + PaddleOCR + Tesseract, all permissive, so
the out-of-the-box stack stays cleanly Apache-compatible. Document this prominently
in `docs/licensing.md` and in the README — license surprises kill adoption.

### 7. Job progress UI

Replace the Phase 06 placeholder with a real progress panel: current stage,
per-page progress for OCR, estimated remaining time, cancel, and a retry button on
failure with the error explained in user language (not a stack trace).

### 8. Fixtures and tests

Add to the corpus: a clean scan, a poor-quality phone photo of a page, a
handwritten-annotation page, a Turkish/Arabic/Chinese multilingual document, a
mixed digital+scanned PDF, and a 900-page scan. Assert tier selection per page,
bbox accuracy on scans, and confidence reporting.

## Acceptance criteria

- [ ] A scanned PDF that failed in Phase 07 now ingests, answers questions, and
      highlights citations on the correct region of the correct page.
- [ ] A mixed document OCRs only its scanned pages, verified by per-page tier logs.
- [ ] `lang_list` measurably improves accuracy on the multilingual fixture.
- [ ] `quality: "advanced"` produces better structure on the hard-layout fixture
      than `standard`, and the difference is visible in the eval numbers.
- [ ] OCR confidence is stored and shown in the UI.
- [ ] The 50-page scanned fixture reaches `ready` in under 2 minutes on CPU.
- [ ] The 900-page fixture completes and survives a mid-job worker restart.
- [ ] The default image contains no AGPL or non-commercial dependency; a CI
      license-audit job asserts this.
- [ ] Citation accuracy on scanned documents stays ≥ 95%.
