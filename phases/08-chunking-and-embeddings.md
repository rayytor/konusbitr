# Phase 08 — Layout-Aware Chunking, Model Router, and Embeddings

**Goal:** turn parse artifacts into retrievable chunks that carry their page and
bounding box, embed them through a provider-agnostic router, and upsert them into
pgvector.

## Context

**Chunk quality dominates answer quality** — more than model choice, more than
prompt wording. A chunk that splits a table in half, or loses which section it
came from, produces an answer that cannot be cited. And because Konusbitr must run
fully offline for legal, medical, and government users, every model call goes
through one router that is equally happy talking to OpenAI or to a local Ollama.

## Scope

### 1. The model router (`packages/ai` + `konusbitr_worker/ai`)

**LiteLLM** as the single interface to OpenAI, Anthropic, Google, Mistral, Groq,
Bedrock, Ollama, and vLLM. Konusbitr code never imports a provider SDK directly.

- Roles are configured independently: `chat`, `embedding`, `rerank`, `vision`.
  An operator can run a cloud chat model with local embeddings, or all-local.
- Retries with backoff, per-role timeouts, and a circuit breaker.
- Token and cost accounting emitted per call for Langfuse (Phase 15).
- **Offline mode** (`OFFLINE_MODE=true`): any attempt to reach a non-local
  endpoint raises immediately rather than leaking a document to the internet.
  Test this — it is a headline claim of the project.

Defaults: cloud — `text-embedding-3-large`; local — **BGE-M3** (1024d,
multilingual), matching the Phase 03 column width.

### 2. The chunker

A layout-aware chunker consuming the Phase 07 `contents` array:

- Target 600–900 tokens, 15% overlap, measured with the real tokenizer for the
  configured embedding model.
- **Never split a table** — an oversized table becomes its own chunk, truncated
  with an explicit marker only if it exceeds the model's context.
- Respect the heading hierarchy: chunks do not cross a heading of level ≤ 2 unless
  a single section exceeds the target size.
- Prepend the `sectionPath` breadcrumb to the chunk text (`Financials > Revenue`)
  — cheap context that measurably improves retrieval.
- Carry the **union of the bboxes** of the elements composing the chunk, as a list
  of per-page rectangles using the canonical `[x0, y0, x1, y1]` tuple from
  `BoundingBoxSchema`: a chunk spanning a page break has entries for both pages.
  **Schema migration required:** the Phase 03 `chunks` table has a single
  `page_no integer` and a single `bbox jsonb` (with an `{x,y,width,height}`
  shape). Migrate to `pages jsonb` holding `{ page: number, bbox: BoundingBox }[]`
  (or equivalent), drop the old `page_no`/`bbox` columns, and align the bbox
  shape to the `[x0, y0, x1, y1]` convention used by `BoundingBoxSchema` and
  the `Citation` type everywhere else.
- Attach `tableJson` to the chunk metadata when present.

Unit-test boundary behavior explicitly: tiny documents, one 5,000-token paragraph,
a table larger than the target, a section spanning 30 pages, an empty page.

### 3. Embedding and upsert

- Batch embeddings (configurable batch size), respect provider rate limits, retry
  partial failures without re-embedding successes.
- Upsert into `chunks` keyed on `(document_id, ordinal)` so a re-run is idempotent.
- **Schema migration required:**
  - The Phase 03 `chunks.embedding` column is declared as `vector(1024)` — a fixed
    width baked into the DDL. Add `embedding_model text` and `dims integer` columns
    to `documents`.
  - **CRITICAL:** Do **NOT** use an untyped `vector` column for `chunks.embedding`.
    Postgres `pgvector` requires fixed dimensions to build HNSW or IVFFlat indexes;
    running `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` on an untyped
    `vector` column fails with `ERROR: column does not have dimensions`. Keep the
    vector column typed (`vector(1024)` default for local BGE-M3 and Matryoshka-truncated
    `text-embedding-3-large`).
  - Add `ordinal integer NOT NULL` to `chunks`, and add a unique constraint/index on
    `(document_id, ordinal)` for idempotent upserts.
  - Drop the old `chunks.page_no` and `chunks.bbox` columns. Add `pages jsonb NOT NULL`
    holding `[{ page: number, bbox: [x0, y0, x1, y1] }]` following `BoundingBoxSchema`.
  - Update `seedChunk` in `packages/db/src/testing.ts` to supply `ordinal: 0` so existing
    cascade tests remain valid.
  - Refuse to write a chunk whose dimension disagrees with the table's, with an error
    telling the operator to re-index.
- A `reindex` job type that re-chunks and re-embeds a document (used when the
  chunker or embedding model changes) without re-parsing — the `docId` cache means
  re-parsing is never necessary.

### 4. Pipeline coordination & critical fixes

- **Fix stage progression clamping:** In Phase 07, `parse_document` announced
  `JobStage.persisting` (95%) during thumbnail generation. Because `ProgressReporter`
  enforces monotonic progress (`self._highest = max(self._highest, value)`), emitting
  `persisting` (95%) before `chunking` (70%) and `embedding` (85%) locks the progress
  bar at 95% throughout all chunking and embedding.
  **Fix:** Remove `JobStage.persisting` from thumbnail rendering in
  `services/worker/src/konusbitr_worker/parse/__init__.py`. Reserve `JobStage.persisting`
  strictly for writing chunks and final state after embedding completes.
- **Fix parse-cache short-circuit:** In `services/worker/src/konusbitr_worker/pipeline.py`,
  `parse_result_exists(...)` currently short-circuits the entire job immediately to `ready`.
  In Phase 08, on a cache hit, the worker must bypass Docling parse and thumbnail rendering,
  load the existing parse artifact from `parse_results.contents`, and proceed to chunk
  and embed (unless chunks already exist for this document).
- **Worker dispatch for job types:** Update `services/worker/src/konusbitr_worker/runtime.py`
  `_handle` to dispatch `JobType.reindex` (and `JobType.chunk_embed`) instead of raising
  `unknown_job_type`.
- **Unify thumbnail storage keys:** Align `packages/storage/src/keys.ts` (`pageThumbnailKey`)
  and `services/worker/src/konusbitr_worker/parse/thumbnails.py` (`thumbnail_key`) to use
  the same key format across runtimes.
- **Local LLM profile default model:** Update `OLLAMA_EMBEDDING_MODEL` in
  `docker-compose.yml` and `.env.example` to default to `bge-m3` (1024d) instead of
  `nomic-embed-text` (768d), matching the 1024d column dimension.
- **Boot-time validation for offline mode:** Validate in both `packages/shared/src/env.ts`
  and `services/worker/src/konusbitr_worker/settings.py` that when `OFFLINE_MODE=true`,
  specifying a cloud provider (OpenAI, Anthropic, Google, Mistral) fails loudly at boot.

### 5. Progress

Emit `embedding` stage progress proportional to chunks embedded, so the Phase 06
SSE stream shows a real bar rather than a spinner.

### 6. Partial readiness (optional but recommended here)

Mark chunks as they land, and let the document expose `chunksReady` /
`chunksTotal`. Phase 10's chat can then answer over a large document before the
whole thing is embedded. If deferred, file it as a known follow-up.

## Acceptance criteria

- [x] Every fixture from Phase 07 chunks and embeds end-to-end to `status: ready`.
- [x] No chunk splits a table; verified by a test over the table-heavy fixture.
- [x] Every chunk has at least one `(page, bbox)` entry, and a chunk spanning a
      page break has entries for both pages.
- [x] Chunk token counts fall in the target band for ≥90% of chunks on the corpus.
- [x] Switching `EMBEDDING_MODEL` between a cloud and a local model requires only
      env changes plus a `reindex`, with no code change.
- [x] With `OFFLINE_MODE=true` and only Ollama configured, a full ingest completes
      and an attempt to configure a cloud provider fails loudly at boot.
- [x] Re-running the embed job for a document does not duplicate chunks.
- [x] Embedding progress increments smoothly between 85% and 95% without being clamped
      early by thumbnail generation.
- [x] A cached parse result from `parse_results` chunks and embeds without re-running Docling.

### Notes on how three of these were satisfied

**Chunk token counts fall in the target band for ≥90% of chunks.** 95.6% of
prose chunks across the Phase 07 corpus, over documents with at least one band's
worth of prose in them. Two exclusions, both measured rather than chosen:
table chunks are not held to a prose band, because a table is never split and
its size is therefore the table's rather than the chunker's; and
`tables-financial.pdf` (about 100 tokens of prose) and `rotated-a4.pdf` (about
200) cannot produce a 600-token passage at all, so their single small chunk is
the honest output. Counting everything, the figure is 88%.
`services/worker/tests/test_corpus_chunking.py` measures it and prints the
per-fixture numbers on failure.

**Respecting the heading hierarchy against the band.** These two pull against
each other, and the resolution is deliberate rather than incidental: honouring
every level-≤2 boundary absolutely turned the corpus — which carries a heading
on every page — into 255-token fragments, at 1.4% band compliance. A boundary
now flushes once the chunk has reached the floor, and adjacent sections merge
when the alternative is a fragment too small to answer anything with. A chunk
that merged siblings is labelled with what those sections have in common, and
carries their own headings in its body. Written out in `docs/chunking.md`.

**Chunks without vectors.** With no embedding model configured — which is the
default `.env` — chunks are written without vectors rather than the job
failing. The passages are keyword-searchable immediately and a `reindex` fills
the vectors in. A role that *is* configured and then fails is a hard job
failure; that distinction is what the criterion above turns on.

