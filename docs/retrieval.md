# Retrieval

How a question becomes eight passages. The decisions behind this are in
`docs/adr/0003-retrieval.md`; this file is the operator's view — what the knobs
do, what each stage costs, and what to look at when retrieval is wrong.

## The pipeline

```
query
  → rewrite      collapse conversation history into a standalone question
  → expand       optionally 3 query variants (MULTI_QUERY_ENABLED)
  → embed        the question, or a hypothetical answer (HYDE_ENABLED)
  → two-stage    on a corpus past CORPUS_TWO_STAGE_THRESHOLD, narrow to 10 docs
  → dense        pgvector HNSW cosine, top 40, org- and scope-filtered
  → sparse       Postgres full-text over `tsv`, top 40, same filters
  → fuse         Reciprocal Rank Fusion, k=60, top 50
  → rerank       cross-encoder, top 50 → top 8 (RERANK_ENABLED)
  → cap          at most 3 chunks from any one document, in corpus scope
  → top K        8 by default
```

Every stage is optional and retrieval still works with all of them off. That is
not politeness: it is what makes `docker compose up` a stack that answers
questions without an API key.

## What each stage costs

Measured on the 100k-chunk benchmark (`pnpm benchmark:retrieval`), per query:

| Stage | Model call | Latency |
| :--- | :--- | :--- |
| Rewrite | one chat call, only with history | cached by `(conversationId, turn)` |
| Multi-query | one chat call | triples the search work |
| HyDE | one chat call | — |
| Dense | one embedding call | ~1ms at 100k chunks |
| Sparse | none | ~13ms p50, and the p95 driver |
| Fusion, cap | none | microseconds |
| Rerank | one rerank call over 50 passages | the largest quality gain per dollar |

The shape worth remembering: **the vector search is not the expensive part.**
The HNSW index makes dense search ~1ms at 100k chunks, and `ef_search` barely
moves it. Full-text ranking and the model calls are where the time goes.

## The knobs

All five are in `.env.example` with their defaults.

`RERANK_ENABLED` — cross-encoder reranking after fusion. Already a pass-through
when no rerank model resolves, so leaving it on costs nothing on a stack with no
`RERANK_MODEL`.

`HYDE_ENABLED` — embed a hypothetical answer instead of the question. Helps a
small corpus; costs a chat call per query. Off by default.

`MULTI_QUERY_ENABLED` — three query variants, fused. Off by default; earns its
keep on vague questions against a large corpus.

`CORPUS_TWO_STAGE_THRESHOLD` (200) — above this many documents, search document
summaries first and confine the chunk search to the best ten. Below it, search
every chunk directly, which is both faster and better.

`HNSW_EF_SEARCH` (40) — how much of the HNSW graph a vector search explores. The
measured recall/latency tradeoff is in `evals/RESULTS.md`. It is applied with
`SET LOCAL` inside the dense query's own transaction, so it cannot leak onto a
pooled connection.

## When retrieval is wrong

**Nothing comes back at all.** Check whether the corpus has vectors:
`SELECT count(*) FILTER (WHERE embedding IS NOT NULL), count(*) FROM chunks`. A
stack with no `EMBEDDING_MODEL` writes chunks without vectors — a supported
state — and retrieval falls back to keyword-only. `POST
/api/documents/:id/reindex` fills them in once a model is named.

**An exact identifier is not found.** That is the sparse leg's job. Check that
the token survives `dropStopWords` (it will unless it is a function word) and
that `to_tsvector('simple', …)` produces the lexeme you expect — the `simple`
configuration does not stem, so `INV-4471-QX` is indexed as written.

**Results are right but from the wrong document.** Corpus scope caps each
document at three chunks; a question whose answer needs four passages from one
document should be asked in document scope.

**Retrieval got slower.** Run `pnpm benchmark:retrieval`. If the p95 moved and
`ef_search` does not change it, the sparse leg is the cause — check how many rows
the query matches, because ranking is proportional to that and a query matching
most of the corpus is the failure mode this pipeline has already had once.

## Measuring a change

`pnpm eval:retrieval` scores the real `retrieve()` against the golden set and
fails when a metric drops more than two points below the recorded baseline. Read
`evals/RESULTS.md` before trusting a number from it: it measures the retrieval
machinery, not embedding quality, because CI embeds with a deterministic hashing
vectorizer rather than a provider.
