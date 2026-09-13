# Konusbitr — Phased Implementation Guide

Konusbitr is an open-source, self-hostable alternative to PDF.ai: upload documents,
chat with them, get answers with clickable page-accurate citations, and drive the
whole thing through a PDF.ai-compatible `/v2` REST API.

This directory splits [`../implementation_plan_1.md`](../implementation_plan_1.md)
into 15 phases. Each file is self-contained: it restates the context an AI agent
needs, lists the work, and ends with hard acceptance criteria. Feed them **in order**
— each phase assumes every earlier phase is merged and green.

| # | File | Outcome |
|---|---|---|
| 01 | `01-monorepo-foundation.md` | Turborepo skeleton, tooling, CI skeleton |
| 02 | `02-local-infrastructure.md` | `docker compose up` brings up the whole stack |
| 03 | `03-database-schema.md` | Drizzle schema + migrations for every core table |
| 04 | `04-auth-orgs-api-keys.md` | Better Auth, organizations, hashed API keys |
| 05 | `05-storage-and-ingest-intake.md` | Presigned uploads, content hashing, docId cache |
| 06 | `06-worker-service-and-queue.md` | Python worker + the TS↔Python job contract |
| 07 | `07-parse-pipeline-v1.md` | Docling parse → markdown + bbox contents |
| 08 | `08-chunking-and-embeddings.md` | Layout-aware chunker, LLM router, pgvector upsert |
| 09 | `09-hybrid-retrieval.md` | Vector + BM25 → RRF → rerank |
| 10 | `10-chat-with-citations.md` | Streaming grounded answers with verified citations |
| 11 | `11-viewer-and-chat-ui.md` | PDF.js viewer + chat UI — **MVP ships here** |
| 12 | `12-robust-ingestion.md` | OCR, languages, VLM `advanced`, images, tables, progress |
| ↳ 12.1/4 | `12.1-4-ocr-pipeline.md` | Scanned page CPU OCR (RapidOCR/Tesseract), OpenCV cleanup, coordinates |
| ↳ 12.2/4 | `12.2-4-multilingual-tables-and-images.md` | Multilingual routing, scanned tables (tableJson), figure extraction/captioning |
| ↳ 12.3/4 | `12.3-4-vlm-advanced-and-licensing.md` | VLM advanced path (Qwen2.5-VL/Claude), hybrid reconciliation, licensing |
| ↳ 12.4/4 | `12.4-4-resilient-scale-and-progress-ui.md` | Checkpointed scale (900 pages), disk spill, partial readiness, progress UI |
| 13 | `13-public-api-v2.md` | parse/extract/split/ask, credits, OpenAPI, SDKs |
| 14 | `14-product-surface.md` | Folders, search, chat-with-all, summaries, sharing, teams |
| 15 | `15-distribution-and-launch.md` | Extension, deploy templates, docs, evals, launch |

**Milestones:** Phase 11 = usable product. Phase 13 = usable API platform.
Phase 15 = a complete open-source PDF.ai alternative.

## Conventions every phase assumes

- Package scope `@konusbitr/*`; Python package `konusbitr_worker`.
- TypeScript strict, Zod v4 for all boundary validation, Drizzle for all SQL.
- Nothing merges without: typecheck, lint, unit tests, and the phase's acceptance criteria.
- Conventional commits; each phase is one or more PRs, never one giant commit.
- Apache-2.0. AGPL/restrictive dependencies (PyMuPDF, Marker) stay behind the
  optional `advanced` Compose profile — the default build must be cleanly permissive.
