# Phase 09 — Hybrid Retrieval, Fusion, and Reranking

**Goal:** given a question and a scope (one document or a whole corpus), return
the 8 chunks most likely to contain the answer — reliably enough that the chat
layer in Phase 10 rarely has to apologize.

## Context

Dense vectors alone miss exact identifiers, part numbers, names, and rare terms;
keyword search alone misses paraphrase. Konusbitr runs both, fuses them with
**Reciprocal Rank Fusion**, and then reranks — the single biggest retrieval
quality win per dollar. This phase is a service with no UI; it is validated by
measurement, not by looking at it.

## Scope

### 1. The retrieval service (`packages/retrieval`)

```ts
retrieve({
  orgId, scope: { kind: "document", documentId } | { kind: "corpus", folderId? },
  query: string,
  history?: Message[],
  topK?: number,          // default 8
}) => RetrievedChunk[]    // text, page, bbox[], documentId, score, sectionPath
```

Pipeline:

1. **Query rewriting** — collapse the last N turns into a standalone query using a
   small/cheap model. Skip when there is no history. Cache by `(conversationId,
   turn)`. If the rewrite model fails, fall back to the raw query rather than erroring.
2. **Dense search** — pgvector HNSW cosine, top 40, filtered by `org_id` and scope.
3. **Sparse search** — Postgres full-text over the generated `tsv`, top 40, same
   filters, using `websearch_to_tsquery` and `ts_rank_cd`.
4. **Fusion** — RRF with k=60 over the two ranked lists.
5. **Rerank** — cross-encoder over the fused top 50 → top 8. Default local
   **BGE-reranker-v2-m3**; Cohere Rerank as a configured alternative; a
   `RERANK_ENABLED=false` path that skips straight from fusion (must still work).
6. **Return** chunks with their page/bbox metadata intact — citations depend on it.

### 2. Corpus mode ("chat with all PDFs")

- **Per-document diversity cap**: at most 3 chunks from any one document, so a
  single verbose PDF cannot crowd out the corpus.
- **Two-stage retrieval for large corpora** (> `CORPUS_TWO_STAGE_THRESHOLD`
  documents, default 200): search document-level summaries first, take the top 10
  documents, then chunk-search within them. Document summaries are generated at
  ingest — add a `summarize` step to the Phase 08 pipeline producing a ~200-token
  abstract stored on `documents` and embedded into a `document_embeddings` table.
- Folder scoping so a user can ask across one folder.

### 3. Sparse-corpus aids

- **HyDE** behind a flag: generate a hypothetical answer, embed that, search with
  it. Measurably helps small corpora; costs a model call. Off by default.
- **Multi-query expansion** for corpus mode: 3 query variants, retrieve each, fuse.

### 4. The golden evaluation set — build it now

Assemble **~200 question/answer pairs with expected source pages** across the
fixture corpus. This is the steering wheel for every retrieval decision that
follows, and building it late means every earlier decision was guesswork.

- Store as `evals/golden/*.jsonl`: `{ question, documentId, expectedPages[], answer }`.
- Harness: `pnpm eval:retrieval` reporting **recall@8**, **MRR**, and
  **context precision**.
- Wire into CI as a nightly job and on any PR touching the chunker, retrieval, or
  prompts. **A drop of more than 2 points in recall@8 fails the check.**

### 5. Performance

Retrieval (excluding the LLM) must complete in **under 400ms p95** on a
100k-chunk corpus. Measure it; add the HNSW `ef_search` tuning knob and document
the recall/latency tradeoff.

## Acceptance criteria

- [ ] `retrieve()` works in both document and corpus scope, org-filtered, with
      page and bbox metadata preserved through every stage.
- [ ] The golden set exists with ≥200 items and `pnpm eval:retrieval` reports
      recall@8, MRR, and context precision.
- [ ] Hybrid+rerank beats dense-only on the golden set — record both numbers in
      `evals/RESULTS.md` as the baseline.
- [ ] A query containing a rare exact token (an invoice number) retrieves the right
      chunk, demonstrating the sparse leg is doing real work.
- [ ] Corpus mode never returns more than 3 chunks from one document.
- [ ] `RERANK_ENABLED=false` still returns sensible results.
- [ ] p95 retrieval latency under 400ms on the 100k-chunk benchmark.
- [ ] CI fails on a deliberately-broken chunker that drops recall by 5 points.
