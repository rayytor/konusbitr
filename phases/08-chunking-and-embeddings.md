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
  of per-page rectangles: a chunk spanning a page break has entries for both pages.
- Attach `tableJson` to the chunk metadata when present.

Unit-test boundary behavior explicitly: tiny documents, one 5,000-token paragraph,
a table larger than the target, a section spanning 30 pages, an empty page.

### 3. Embedding and upsert

- Batch embeddings (configurable batch size), respect provider rate limits, retry
  partial failures without re-embedding successes.
- Upsert into `chunks` keyed on `(document_id, ordinal)` so a re-run is idempotent.
- Record `embedding_model` and `dims` on the document; refuse to write a chunk
  whose dimension disagrees with the table's, with an error telling the operator
  to re-index.
- A `reindex` job type that re-chunks and re-embeds a document (used when the
  chunker or embedding model changes) without re-parsing — the `docId` cache means
  re-parsing is never necessary.

### 4. Progress

Emit `embedding` stage progress proportional to chunks embedded, so the Phase 06
SSE stream shows a real bar rather than a spinner.

### 5. Partial readiness (optional but recommended here)

Mark chunks as they land, and let the document expose `chunksReady` /
`chunksTotal`. Phase 10's chat can then answer over a large document before the
whole thing is embedded. If deferred, file it as a known follow-up.

## Acceptance criteria

- [ ] Every fixture from Phase 07 chunks and embeds end-to-end to `status: ready`.
- [ ] No chunk splits a table; verified by a test over the table-heavy fixture.
- [ ] Every chunk has at least one `(page, bbox)` entry, and a chunk spanning a
      page break has entries for both pages.
- [ ] Chunk token counts fall in the target band for ≥90% of chunks on the corpus.
- [ ] Switching `EMBEDDING_MODEL` between a cloud and a local model requires only
      env changes plus a `reindex`, with no code change.
- [ ] With `OFFLINE_MODE=true` and only Ollama configured, a full ingest completes
      and an attempt to configure a cloud provider fails loudly at boot.
- [ ] Re-running the embed job for a document does not duplicate chunks.
