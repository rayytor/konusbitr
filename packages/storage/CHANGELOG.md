# @konusbitr/storage

## 0.1.0

### Minor Changes

- Phases 09 to 13, which landed without a changeset each and are recorded here
  together so the first tagged release describes what it contains.

  `@konusbitr/retrieval` is new: `retrieve()` runs a dense pgvector leg and a
  Postgres full-text leg, fuses them with RRF at k=60, reranks, and caps any one
  document at three of the eight chunks it returns. A leg that fails is reported
  through `onLegError`, and two that fail raise.

  `@konusbitr/shared` carries everything that has crossed the seam since Phase 08:
  table cells and figures on the parse contract, the vision tier's cost
  arithmetic and the `too_many_pages` refusal, checkpoints, page counts and
  cancellation for resumable ingestion, and the `/v2` request and response
  schemas the OpenAPI document is generated from.

  `@konusbitr/db` adds the conversation and message queries behind chat, the
  checkpoint column on `parse_results` — every docId cache reader filters on
  `checkpoint IS NULL` — the credit ledger and API-job queries behind `/v2`, and
  a one-time starting-credit grant so metered mode admits a new organization.

  `@konusbitr/ai` gains chat streaming through the router, the versioned prompt
  files, per-organization provider keys and the vision role.

  `@konusbitr/storage` signs browser-facing URLs against `S3_PUBLIC_ENDPOINT`,
  without which a Compose deployment could not serve a document to the viewer.

  `@konusbitr/web` is versioned for the first time. It is where `/api/health`,
  the landing page and the OpenAPI document read the product's version from, and
  it was on the changesets ignore list, so all three reported `0.0.0`. Since
  Phase 08 it has gained chat with verified citations, the viewer and the
  workspace, the OCR and vision tiers' surfaces, resumable ingestion with cancel
  and retry, and the public `/v2` API.

### Patch Changes

- 11e0e07: Phase 08: layout-aware chunking, the model router, and embeddings.

  `@konusbitr/shared` gains the chunk contract (`ChunkPage`, `ChunkMeta`,
  `CHUNKING_DEFAULTS`), the model-router vocabulary (`MODEL_ROLES`, the
  local/cloud provider partition, `EMBEDDING_DIMENSIONS`), and the environment
  variables for both — including the boot-time refusal to start with
  `OFFLINE_MODE=true` and a cloud provider named for any role.

  `@konusbitr/db` migrates `chunks` to the location shape the citation machinery
  needs: `ordinal` plus a unique `(document_id, ordinal)` for idempotent upserts,
  and `pages jsonb NOT NULL` holding `[{ page, bbox: [x0, y0, x1, y1] }]` in place
  of the Phase 03 `page_no` and `{x, y, width, height}` columns. `documents` gains
  `embedding_model`, `dims`, `chunks_ready` and `chunks_total`.

  `@konusbitr/ai` is new: role resolution, offline enforcement, retries with full
  jitter, a per-role circuit breaker, usage accounting, and embeddings over the
  OpenAI-compatible route.

  `@konusbitr/storage` aligns `pageThumbnailKey` with the worker's
  `thumbnail_key`; the two had drifted.
