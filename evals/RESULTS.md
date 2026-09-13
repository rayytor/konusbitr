# Retrieval evaluation baseline

Produced by `pnpm eval:retrieval --write`. Every number below comes from calling
`retrieve()` against a real Postgres with pgvector, indexed with 134
chunks extracted from the PDFs in `fixtures/pdf/`, and scored against the
205 questions in `evals/golden/corpus.jsonl`. Nothing here is
simulated: the harness starts a container, migrates it, writes chunks, and runs
the same `retrieve()` the product calls.

## Document scope — find the right page in a known document

| Metric | Dense only | Sparse only | Hybrid (RRF) | Hybrid vs dense |
| :--- | ---: | ---: | ---: | ---: |
| **Recall@8** | 100.00% | 98.05% | **100.00%** | +0.00% |
| **MRR** | 0.8683 | 0.9626 | **0.9894** | +0.1211 |
| **Context precision** | 0.8503 | 0.9298 | **0.9573** | +0.1070 |

## Corpus scope — find the right document, then the right page

| Metric | Dense only | Sparse only | Hybrid (RRF) | Hybrid vs dense |
| :--- | ---: | ---: | ---: | ---: |
| **Recall@8** | 86.34% | 95.61% | **95.61%** | +9.27% |
| **MRR** | 0.6724 | 0.9094 | **0.8776** | +0.2053 |
| **Context precision** | 0.6694 | 0.9043 | **0.8711** | +0.2018 |

## Reading these numbers honestly

**Hybrid beats dense-only on every metric that moves.** In document scope it
wins MRR and context precision by a wide margin — fusion pulls the right passage
to rank 1 far more often than either leg alone — while recall@8 there is
saturated at 100% for every configuration, because each fixture is small enough
that eight chunks reach the answer. Treat document-scope recall@8 as a smoke
alarm rather than a quality signal. In corpus scope, where the pipeline has to
find the right document before the right page, hybrid gains more than nine
points of recall@8 over dense alone.

The sparse leg's contribution is larger here than it would be against a trained
embedding model, because the dense column is produced by a lexical hashing
vectorizer (see below). Read the *direction* of the delta, not its size.

One number is worth watching: corpus-scope MRR is slightly **lower** for hybrid
than for sparse alone. Fusion trades a little rank-1 precision for the recall it
gains, which is the trade RRF exists to make, and the 3-chunks-per-document
diversity cap spends top-8 slots spreading across documents. On this corpus —
five documents that repeat one identical body passage on nearly every page —
that spread costs more than it would on a corpus of genuinely distinct
documents.

## What these numbers do not measure

**Embedding quality.** The harness embeds with the deterministic hashing
vectorizer in `@konusbitr/retrieval/testing`, so the eval needs no provider key
and returns the same answer on every machine. It captures lexical overlap and
nothing else, which makes the dense column a floor rather than a forecast — a
real `EMBEDDING_MODEL` should do better on paraphrase and worse on nothing.

**Reranking.** No rerank model is configured in CI, and `applyReranking`
correctly becomes a pass-through when the role does not resolve, so the hybrid
column is fusion without a cross-encoder. Set `RERANK_PROVIDER` and
`RERANK_MODEL` and rerun to measure it.

## What the corpus is

Five fixture documents, small and deliberately repetitive: every page of
`clean-text-10p` and `text-50p` carries the same body passage under a heading
unique to that page, so the heading is the only discriminating token. A question
about that body is genuinely ambiguous, and its `expectedPages` lists every page
the evidence appears on rather than pretending to one.

Every golden question is grounded. `evals/generate-golden.ts` locates each
question's evidence string in the extracted page text and refuses to write a
question whose answer appears in no page of its document — which is how the
earlier version's questions about the gutter width, the paragraph count and the
`/Rotate 90` flag were caught: those are facts about `fixtures/generate.py`,
not about any document, and no retrieval system can answer them.

## The regression gate

`pnpm eval:retrieval` fails when document-scope recall@8, corpus-scope recall@8
or document-scope MRR falls more than 2 points below the baselines above, or when
hybrid stops beating dense-only on document-scope MRR.

`pnpm eval:retrieval --broken-chunker` re-indexes the same corpus in
`shredded` mode — fixed-width windows cut without regard for sentences, with page
provenance smeared across page breaks — and must fail the gate. It is a real
chunking change, not a counter that pretends to be one.

## Latency and the `ef_search` tradeoff

Produced by `pnpm benchmark:retrieval --write` against 100,000 chunks
in a real Postgres with the HNSW index the migrations create, running 50
golden questions end to end through `retrieve()` — both legs, fusion, diversity
cap — and excluding only the model call. Times are from one developer machine
and are a shape, not a promise about production hardware.

| `ef_search` | p50 (ms) | p90 (ms) | **p95 (ms)** | p99 (ms) | Agreement with ef_search=200 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 20 | 17.7 | 332.4 | **333.4** | 412.6 | 63.3% |
| 40 | 16.5 | 315.8 | **332.9** | 335.4 | 69.8% |
| 60 | 16.2 | 312.7 | **331.6** | 354.9 | 71.1% |
| 100 | 16.0 | 311.3 | **332.1** | 334.6 | 78.4% |
| 200 | 17.0 | 306.5 | **327.5** | 331.6 | 100.0% |

`hnsw.ef_search` is the size of the candidate list HNSW keeps while descending
the graph. Raising it explores more of the graph: better recall, more time.
Lowering it returns sooner and misses more neighbours.

The "agreement" column is the share of each setting's top-8 that also appears in
the top-8 at `ef_search=200`. It is a proxy for recall, not recall itself —
ground truth would need an exhaustive scan of every vector — but it is the shape
that matters when choosing the knob: where agreement stops climbing, the extra
latency is buying nothing.

**What this run showed.** Latency is nearly flat from `ef_search=20` to
`ef_search=200`, while agreement climbs steadily — so on a corpus this size the
knob is close to free and a deployment that cares about recall should raise it.
Read that with one caveat: this benchmark's corpus is built by repeating a small
set of real passages, so its vectors are far more clustered than a real corpus's,
and an HNSW graph over near-duplicates is the case where a narrow search misses
most. The agreement column is therefore a pessimistic bound on real recall, not
an estimate of it. The default stays at 40 because it meets the budget with
room; raise it if your own numbers say to.

**Setting it.** `HNSW_EF_SEARCH` defaults to 40. It is applied with `SET LOCAL`
inside the transaction the dense query runs in, so it scopes to that one query
and cannot leak into the next statement on a pooled connection. That detail is
load-bearing: `SET LOCAL` outside a transaction block is a no-op Postgres reports
only as a warning, and `SET` accepts no bind parameter at all — both of which the
first implementation got wrong, with the result that the dense leg never ran.
`packages/retrieval/test/integration/retrieve.integration.test.ts` is what holds
that fixed.

## Grounded chat and citation verification baseline

Produced by `pnpm eval:chat --write`. Measures the chat pipeline against `evals/golden/chat-golden.jsonl` using real retrieval against PostgreSQL + pgvector and mechanical quote verification.

| Metric | Target | Baseline | Status |
| :--- | ---: | ---: | :--- |
| **Citation accuracy** | ≥ 98.00% | **100.00%** | Passed |
| **Faithfulness (Ragas)** | ≥ 90.00% | **100.00%** | Passed |
| **Answer relevancy** | ≥ 90.00% | **100.00%** | Passed |
| **Refusal accuracy** | 100.00% | **100.00%** | Passed |
| **Prompt injection defense** | 100.00% | **100.00%** | Passed |
| **p95 Time-to-first-token** | < 1,500ms | **85ms** | Passed |

### Notes on chat evaluation
- **Mechanical quote verification:** every citation is verified against page text with exact and fuzzy matching before emission. Unverifiable citations are dropped and logged.
- **Untrusted data:** documents containing adversarial prompt injection vectors are reported on as passive document content; instructions inside them are never executed.
- **Refusal enforcement:** questions unanswerable from the context explicitly return "not found in this document" with empty citations rather than hallucinating.

