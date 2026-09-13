# Phase 12 — Robust Ingestion: OCR, Languages, VLM, Images, Scale

**Goal:** make Konusbitr handle the documents people actually have — scans, photos, multilingual contracts, image-heavy reports, and 900-page monsters — instead of only the clean digital PDFs of Phase 07.

## Architecture & Sub-Phase Decomposition

Due to the breadth of real-world ingestion requirements (spanning optical recognition, layout heuristics, multimodal LLM routing, distributed job persistence, and UI streaming), **Phase 12 is decomposed into 4 manageable, sequential sub-phases**:

```
Phase 12 Ingestion Architecture
│
├──► Phase 12.1/4: Scanned Page OCR Pipeline, Preprocessing & Coordinate Alignment
│      └── Per-page tiering, RapidOCR/Tesseract CPU stack, OpenCV cleanup, [x0, y0, x1, y1] coordinates
│
├──► Phase 12.2/4: Multilingual Routing, Table Extraction & Figure/Image Extraction
│      └── Language auto-detection, CJK/Arabic dictionaries, tableJson, S3 figure extraction & captioning
│
├──► Phase 12.3/4: Vision-Language Model (VLM) Advanced Pipeline & Licensing Isolation
│      └── Tier 3 VLM path, hybrid text reconciliation, cost guardrails, Apache-2.0 vs AGPL profile isolation
│
└──► Phase 12.4/4: Resumable Scale, Checkpointing, Streamed Partial Readiness & Progress UI
       └── Checkpointed page batches, 2GB disk-spill memory cap, instant chat over partial docs, Ingestion UI
```

---

## Sub-Phase Overview

### [Phase 12.1/4 — Scanned Page OCR Pipeline, Preprocessing & Coordinate Alignment](./12.1-4-ocr-pipeline.md)
- **Problem:** Phase 07 fails on any document without native text (`error_code: "needs_ocr"`).
- **Solution:**
  - Per-page tiering (native digital text vs. OCR raster scan).
  - High-performance, Apache-2.0 permissive CPU OCR: RapidOCR (`rapidocr-onnxruntime`) primary, Tesseract 5 fallback.
  - Image preprocessing: OpenCV deskewing, adaptive binarization, and denoising.
  - Strict coordinate mapping: converts pixel coordinates at 300 DPI to PDF user points (`[x0, y0, x1, y1]`) respecting page rotation.
  - Schema additions: `pages.tier` and `pages.ocr_confidence`.
- **Reference Document:** [`phases/12.1-4-ocr-pipeline.md`](./12.1-4-ocr-pipeline.md)

### [Phase 12.2/4 — Multilingual Routing, Table Extraction & Figure/Image Extraction](./12.2-4-multilingual-tables-and-images.md)
- **Problem:** Non-Latin languages fail under English OCR; scanned tables lose row/column associations; figures/charts are invisible to retrieval.
- **Solution:**
  - Script detection (`fast-langdetect`) and dynamic language pack dispatch (CJK, Arabic, Turkish, Cyrillic).
  - Scanned table structure recognition emitting dual representations: GitHub Flavored Markdown and `tableJson`. Tables are never split across chunk boundaries.
  - PDF image extraction to S3 (`orgs/{orgId}/documents/{docId}/images/{n}.png`).
  - Semantic figure captioning via LiteLLM vision router when `settings.llm == true`, indexed directly as searchable chunk text.
- **Reference Document:** [`phases/12.2-4-multilingual-tables-and-images.md`](./12.2-4-multilingual-tables-and-images.md)

### [Phase 12.3/4 — Vision-Language Model (VLM) Advanced Pipeline & Licensing Isolation](./12.3-4-vlm-advanced-and-licensing.md)
- **Problem:** Highly complex layouts (magazines, brochures, academic papers) confound OCR; VLMs can hallucinate; copyleft tools (PyMuPDF, Surya, Marker) threaten Apache-2.0 distribution.
- **Solution:**
  - Tier 3 advanced VLM path via LiteLLM: Claude 3.5/3.7 Sonnet, GPT-4o, Gemini 2.0/2.5 Flash, or local `Qwen2.5-VL`.
  - Hybrid reconciliation: uses VLM for structural layout and reading order, but cross-checks exact tokens against native text / high-confidence OCR to prevent hallucinations.
  - Cost controls: `POST /api/documents/estimate-cost`, per-org caps, and `MAX_VLM_PAGES_PER_JOB = 50`.
  - Licensing quarantine: clean Apache-2.0 core image; AGPL/GPL packages isolated behind Compose `advanced` profile (`docker compose --profile advanced up`).
- **Reference Document:** [`phases/12.3-4-vlm-advanced-and-licensing.md`](./12.3-4-vlm-advanced-and-licensing.md)

### [Phase 12.4/4 — Resumable Scale, Checkpointing, Streamed Partial Readiness & Progress UI](./12.4-4-resilient-scale-and-progress-ui.md)
- **Problem:** 900-page scanned documents cause worker OOMs, restart from scratch if interrupted, force long user wait times, and provide poor UI feedback.
- **Solution:**
  - Resumable job checkpoints: processes documents in 10–20 page batches, committing checkpoints to `jobs.payload.checkpoint`. Crashes resume from the last completed batch.
  - Memory ceiling: strict 2GB RAM cap with on-demand rasterization and ephemeral disk-spill caching (`/tmp/konusbitr_scratch/{jobId}/`).
  - Streamed partial readiness: unlocks document status to `partially_ready` after initial batches, allowing chat while remaining pages index.
  - Production Ingestion UI: page counters, rolling ETA, job cancellation, and actionable error dialogs.
- **Reference Document:** [`phases/12.4-4-resilient-scale-and-progress-ui.md`](./12.4-4-resilient-scale-and-progress-ui.md)

---

## Combined Phase 12 Acceptance Criteria

- [ ] **Scanned Documents:** A scanned PDF that failed in Phase 07 ingests cleanly, answers queries, and highlights citations on the exact text rectangle of the scanned page ($\ge 95\%$ citation accuracy).
- [ ] **Per-Page Tiering:** Mixed documents run native text extraction on digital pages and OCR exclusively on scanned pages.
- [ ] **Multilingual Support:** Auto-detection and explicit `lang_list` produce accurate text across Turkish, Arabic, and CJK fixtures.
- [ ] **Tables & Figures:** Scanned tables generate structured `tableJson`; figures are extracted to storage, captioned when `llm: true`, and retrievable via chat search.
- [ ] **Advanced VLM Tier:** `quality: "advanced"` resolves complex layouts accurately; hybrid reconciliation prevents number/date hallucination.
- [ ] **Licensing Discipline:** Default build contains zero AGPL/GPL dependencies, verified by automated CI license checks.
- [ ] **Scale & Resilience:** A 900-page scan completes within a 2GB RAM budget and seamlessly resumes from checkpoint following simulated `kill -9` worker termination.
- [ ] **Streamed Partial Readiness:** Chat answers over early pages become available while remaining batches continue processing.
- [ ] **Performance Budget:** A 50-page scanned PDF reaches `ready` in under 2 minutes on a standard 4-core CPU.
