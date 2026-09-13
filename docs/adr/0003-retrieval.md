# 0003 — Hybrid retrieval: two legs, RRF, and what the eval is allowed to claim

**Status:** accepted (Phase 09)

## Context

A question has to become eight passages. Dense vector search alone misses exact
identifiers — invoice numbers, part codes, proper nouns, anything rare — because
an embedding of a rare token is mostly noise. Keyword search alone misses
paraphrase, which is most of how people ask questions. Konusbitr runs both and
fuses them.

None of that is novel. What this ADR records is the three decisions inside it
that were not obvious, and one that was got wrong on the first attempt and is
worth writing down so it is not got wrong again.

## Decision

### Reciprocal Rank Fusion with k=60, over scores

The two legs produce incomparable numbers: cosine similarity is bounded and
roughly calibrated, `ts_rank_cd` is unbounded and depends on document length.
Normalizing them onto a common scale means inventing a weighting, and the
weighting is then a hyperparameter nobody can tune without the eval that does
not exist yet.

RRF uses only the *ranks*, so there is nothing to calibrate:
`score(d) = Σ 1 / (k + rank(d))`. `k=60` is the value from the original paper and
it is not sensitive; it exists to stop rank 1 dominating rank 2 by a factor of
two. The property that matters is that adding a leg cannot cost recall, which
is what makes "turn the reranker off and it still works" true rather than
hopeful.

### The sparse leg ORs its terms, and drops function words first

`websearch_to_tsquery` is the right parser — it understands quoted phrases and
`-exclusion` the way a search box does — but its implicit operator is AND, and
`chunks.tsv` is built with the `simple` configuration, which strips no stop
words because the corpus is multilingual.

Both of those are individually correct and together they are fatal. "What was
Licensing revenue in 2023?" parses to
`'what' & 'was' & 'licensing' & 'revenue' & 'in' & '2023'`, and no passage
contains all six words. The sparse leg returned **zero rows for every
natural-language question** — which is every question a chat product asks.

So the conjunction is rewritten to a disjunction and `ts_rank_cd` does the
ranking it is for. That alone swings the other way: a query containing "the"
then matches nearly every chunk. On the 100k-chunk benchmark the OR query
matched 98,485 of 100,000 rows, and ranking all of them cost 558ms p50 and
1269ms p95 against a 400ms budget.

The fix is to drop function words from the *query* and never from the *index*:
the index keeps every token a document contains, exactly as written, so an exact
search for a rare string still works. Dropping them left 1,515 matches, the same
top 40, 13ms p50 — and, unexpectedly, nine points more corpus recall@8, because
the function-word matches had been crowding real ones out.

A query carrying a negation keeps its AND form. `!'licensing'` OR'd against the
rest matches every passage that merely lacks the excluded word, which is the
opposite of what was asked for.

### `hnsw.ef_search` is set with `SET LOCAL`, inside the query's own transaction

This is the one that was got wrong. The first implementation issued

```ts
await db.execute(sql`SET LOCAL hnsw.ef_search = ${efSearch}`);
```

outside any transaction. Two independent defects:

- `SET` is a utility statement and accepts no bind parameter, so Drizzle's
  `$1` is a syntax error.
- `SET LOCAL` outside a transaction block is a no-op that Postgres reports only
  as a `WARNING`.

The statement therefore threw on every call — and the call site wrapped the
dense leg in `.catch(() => [])`, so **every retrieval silently degraded to
keyword-only**. No error, no log, no failing test: the unit tests mocked the
database with an object that had no `execute`, so the throw was
indistinguishable from the mock.

The value is now interpolated after being clamped to an integer in `[1, 1000]`
— there is no other way to pass it — and the query runs inside a transaction so
the setting cannot leak onto a pooled connection.

### A failing leg is reported; two failing legs raise

The bug above survived because an empty result set and a broken query looked
identical to the caller. They are now distinguished. A leg returning nothing is
ordinary — a corpus with no vectors yet is a supported state. A leg *throwing*
reaches the caller through `onLegError`, and if every leg throws, `retrieve()`
raises rather than returning `[]`, which would read as "no matches".

`packages/retrieval/test/integration/retrieve.integration.test.ts` runs the real
SQL against a real Postgres. Reverting the `ef_search` fix turns seven of its
twelve tests red with `syntax error at or near "$1"`.

## The eval, and what it is allowed to claim

`pnpm eval:retrieval` starts a Postgres, indexes the fixture corpus, and calls
the real `retrieve()`. It measures the retrieval machinery — the SQL, the
filters, fusion, the diversity cap, whether page provenance survives — and it
does not measure embedding quality, because it embeds with a deterministic
hashing vectorizer so that it needs no provider key and returns the same numbers
on every machine.

That boundary is the point. An earlier version of this harness computed its
metrics from a hand-written simulator and reported 98.10% recall@8; the numbers
were arithmetic on a fabricated ranking and would not have moved if retrieval
had been deleted. `evals/RESULTS.md` now states what each column does and does
not cover, and the golden-set generator refuses to write a question whose answer
appears in no page of its document.

## Consequences

- Retrieval needs Postgres to be tested meaningfully. `pnpm test:integration`
  covers it; the unit tests cover fusion, capping and the stop-word rewrite,
  which are pure functions.
- The stop-word list is a small, explicit list covering English and Turkish.
  Adding a language is additive. A word wrongly added costs recall on queries
  that hinge on it, which is why the list stops at function words.
- The eval's absolute numbers are not comparable to a deployment running a real
  embedding model. Deltas between configurations are.

## Revisit when

- A corpus in a language the stop-word list does not cover shows poor sparse
  recall.
- `ts_rank_cd` becomes the p95 again on a corpus with different statistics; the
  next step is a RUM index or a bounded candidate set, both of which trade
  exactness for latency and neither of which is needed yet.
- An eval run against a real embedding model exists to compare against, at which
  point the hashing vectorizer becomes a CI stand-in rather than the only
  measurement.
