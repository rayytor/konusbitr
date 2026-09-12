---
'@konusbitr/shared': minor
'@konusbitr/db': minor
'@konusbitr/ai': minor
'@konusbitr/storage': patch
---

Phase 08: layout-aware chunking, the model router, and embeddings.

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
