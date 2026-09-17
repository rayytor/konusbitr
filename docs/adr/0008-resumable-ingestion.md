# 0008 — Resumable ingestion: page batches, checkpoints, partial readiness

**Status:** accepted (Phase 12.4/4)
**Supersedes nothing.** Extends `0001-queue.md` (delivery) and `0005-ocr.md` (tiering).

## Context

Phases 07 through 12.3 read a document in one pass. Inspect it, hand the
born-digital pages to Docling, hand the scanned ones to the recogniser, produce
one artifact, chunk it, embed it, done. That is the right shape for the ten-page
PDF most uploads are, and it fails in four separate ways on the documents this
phase exists for — a 300-page regulatory filing, a 500-page discovery bundle, a
900-page scanned manual.

It holds hundreds of decoded page bitmaps at once. A 300 DPI Letter page is
about 25MB decoded, so a 900-page scan read in one pass is twenty-two gigabytes
and the kernel kills the worker somewhere around page 400.

It loses everything to a restart. A container recycled at page 850 of 900 starts
again at page one — a quarter of an hour of CPU, and on a document uploaded with
`llm: true` a second round of vision-model spend the reader has already paid for.

It makes a reader wait for all of it. The answer is on page four and page four
was readable fourteen minutes ago, and they are looking at a spinner.

And the spinner says nothing. A bar with no denominator on a job that takes
fifteen minutes is indistinguishable from a deadlock.

## Decision

**The single pass becomes a loop over contiguous page batches, and a batch is a
commit point.** Everything in a batch — its elements, its page rows, its figures
— belongs to one span of pages. When the span is done it is written durably
together with a record of how far the job got, and the next span starts where
it stopped.

Four consequences follow, and they are the phase:

- **Memory is bounded by the batch, not the document.** Only one batch's pages
  are ever decoded, and `gc.collect()` runs between batches because what is
  being freed is numpy and PIL buffers rather than Python objects.
- **A crash costs one batch.** The worker reads the checkpoint on redelivery
  and resumes at the page after it.
- **The document becomes answerable at the first batch.** Its chunks are
  embedded as part of that batch, so `partially_ready` is a claim that can be
  made honestly.
- **Progress is reportable in pages**, which is the unit a reader can estimate
  from.

### Where the checkpoint lives, and why it is not a column of its own

`parse_results.checkpoint`, a nullable `jsonb`, on the row the job is building.
The rule is one sentence: **a row with a checkpoint is not a docId cache entry.**

The alternative considered was a separate `ingest_checkpoints` table keyed on
the job. It was rejected because the checkpoint and the partial artifact have to
be written together or the whole scheme is unsound — a checkpoint saying "page
850 done" beside an artifact holding 800 pages resumes into a document with a
hole in it — and the partial artifact has to live in `parse_results` because
that is where the finished one lives and the last batch simply stops being
partial. Two tables would have meant a distributed write with no transaction
spanning it, in service of separating two facts that are never useful apart.

The consequence is that every reader of the docId cache, in both runtimes,
filters on `checkpoint IS NULL`: `Database.parse_artifact` in the worker and
`globalParseResultByHashes` in `packages/db`. That is one predicate in two
places rather than a new table, and it is enforced by
`test_resumable_ingest.py::test_a_half_finished_parse_is_never_served_as_a_cache_hit`.

The checkpoint is also mirrored into `jobs.payload.checkpoint`, which the phase
specification asks for. That copy is for an operator reading the job table; the
`parse_results` one is what the worker reads on resume. Nothing branches on the
mirror.

### The checkpoint is written after the work it describes

This is the ordering that matters, and it was wrong once during implementation
in a way worth recording because the failure is silent.

The first version wrote the artifact and its checkpoint, then indexed the
batch's chunks. The checkpoint therefore recorded the chunk count from *before*
the batch: "pages 1–8 done, 2 chunks written" while four chunks were in the
table. The resumed run began numbering at 2, overwrote the chunks for pages 5–8,
and then pruned everything past its final count — deleting the document's tail.
The result was a document that looked fully indexed and answered out of two
thirds of itself, which is precisely the class of failure the whole product is
built to prevent.

The correct order is: **index the batch, then record that it was indexed.**
Crashing in the gap is harmless and is the case the order is chosen for — the
chunks exist at ordinals the resume will write again, every write is an upsert,
and the pages are simply read once more.

### Batches are contiguous and equal-sized, not balanced by cost

A batch of sixteen scanned pages costs far more than sixteen born-digital ones,
so the time per batch varies and progress is not perfectly smooth. That was
accepted deliberately: contiguity is what lets a checkpoint be a single page
number, and a single page number is what makes a resume unambiguous. Balancing
by cost would buy smoother progress and pay for it with a checkpoint that had to
enumerate which pages were done — a set, with all the reconciliation that
implies, in a `jsonb` column.

Sixteen is the default. It is roughly four seconds of OCR on a four-core CPU:
enough work that the commit overhead is negligible, little enough that losing it
to a crash is not felt. Changing it invalidates in-flight checkpoints, because a
resume must land on the boundaries the interrupted run used — the worker refuses
such a checkpoint, logs why, and reads the document again rather than stitching
it together at two different strides.

### Chunk boundaries land on batch edges

A chunk is built from a batch's elements alone, so the chunker cannot merge the
last paragraph of page 16 with the first of page 17. At a sixteen-page batch
that is one avoidable boundary per sixteen pages, and it is the price of the
batch being a real commit point. It is stated in `docs/chunking.md` rather than
hidden: a passage split at a batch edge is still citable, still carries its page
and its box, and is retrieved on either side.

Ordinals continue across batches and across a resume. They have to: chunks are
upserted on `(document_id, ordinal)` and the final prune deletes everything past
the count, so a batch that restarted its numbering would overwrite its
predecessor and then delete the tail. That is the same bug as the ordering one
above, reached from a different direction, which is why both have tests.

### Two statements are deferred to the end

`embed_and_store` normally does two things that are about the *document* rather
than about the chunks in front of it, and the batched path passes `finalize=False`
to suppress both.

The **prune** is "delete everything past the final count", and there is no final
count until the last batch. The **embedding model** recorded on the document is
a claim that this document's index was built by that model; making it after
sixteen of nine hundred pages would tell a deployment looking for documents to
reindex that this one is already done.

Both are done once, by `_finalize_index`, when the document is whole.

### Cancellation is a Redis key, and a cancelled job is not a failed one

The two runtimes share no control channel, and a cancellation has to survive the
worker not having been listening at the moment it was made — so
`konusbitr:cancel:{jobId}` is set by the web app and polled by the worker twice
a second while a job runs.

The poll is cached on the event loop and read as a plain boolean, because the
predicate has to be answerable **synchronously** from inside the worker threads
where recognition happens; there is no loop there to await a Redis round trip
on. A cancellation is therefore noticed within one poll interval plus one page,
rather than within one sixteen-page batch, which is what makes the phase's
two-second budget reachable at all. A Redis that cannot be reached is *not* a
cancellation: guessing wrong in that direction stops a document halfway for no
reason the reader can see.

`JobCancelled` is deliberately not a `JobFailure`. Every branch that handles a
failure does something a cancellation must not — spends a retry, writes a dead
letter, marks a document `failed` in red, files a line in the operator's
failed-jobs view. A person stopping their own upload is none of those. And
because a batched parse commits as it goes, **a cancelled document is a short
document rather than a broken one**: the pages that were read were read
properly, they are indexed, and they can still be searched and cited.

The web app writes the `cancelled` status itself rather than waiting for the
worker's confirmation, so the button takes effect within the two seconds the
phase asks for rather than within a page of OCR. Both writes are idempotent, and
`record_stage` refuses to move a document out of `cancelled` — the batch that
was in flight when the flag landed must not un-cancel it on its way out.

### `partially_ready` is a status, not a decoration

It is what says the viewer may open the document and chat may answer over it.
The honesty of that rests entirely on the chunks: a chunk exists only because
the page it came from was read, so an answer over a partially-ready document is
grounded in pages that genuinely have been parsed, and its citations verify
against real page text exactly as they would at the end. Nothing in the citation
machinery needed changing for this, which is the strongest evidence that the
status is not a shortcut.

It is not terminal — a client watching it must keep its progress stream open —
and `record_stage` refuses to walk a document back out of it, because the status
is an assertion a reader is acting on and taking it away every sixteen pages
would close the document under them fifty-six times during a long ingest.

### Named stages for a single pass, page counts for a batched one

In a document read in one pass the stages are sequential and naming them is
honest: `chunking` then `embedding` then `persisting`, with the bar moving
through the embedding band as chunks land. That is almost every upload and it
behaves exactly as it did before this phase.

In a batched ingest the stages **interleave** — page 17 is being recognised
while pages 1 to 16 are being embedded — so there is no stage the bar could sit
inside. Announcing `embedding` at the first batch would pin it at 85% for the
remaining fourteen minutes; announcing it per batch would flip the label
fifty-six times. So the batched path reports pages instead, spread across the
same `parsing`-to-`persisting` span so that a browser replaying from the `jobs`
row lands in the range the live frames drew in.

### The ETA is computed on the client, from observed throughput

A rolling average over the last six page observations, not over the whole run,
because the rate genuinely changes: a filing whose first two hundred pages are
born-digital and whose last fifty are photocopies goes an order of magnitude
slower at the end. It is omitted entirely — rather than guessed — when the page
count is unknown, when nothing has moved yet, or when the window is too short to
mean anything. A number on a screen somebody is waiting at is a promise, and a
wrong one is worse than none.

It lives on the client because it is a property of *this viewer's* observation
of the stream, and because computing it in the worker would put a rate estimate
in a durable row that a reconnecting browser would then have to decide whether
to trust.

## Alternatives considered

**Keep the single pass and raise the worker's memory limit.** Moves the cliff
rather than removing it, does nothing for resumability or partial readiness, and
makes a 900-page document a machine-sizing question for every self-hoster.

**Split a long document into several jobs at intake.** Attractive — it needs no
checkpoint at all — and rejected because a document is one parse: the language
route, the docId cache key, the summary and the element numbering are all
document-level, and reassembling them across jobs is strictly more machinery
than a loop with a commit point. It also makes "cancel this document" an
operation over an unknown number of queue entries.

**A separate checkpoint table.** Covered above: it separates two facts that are
never useful apart and turns one write into two without a transaction over them.

**`SIGTERM` the job for cancellation.** A page half recognised and half written
is worse than a page that finishes, and the cost of finishing one is about a
second. The flag is a request, not a kill, and it says so.

## Consequences

- `parse_results` rows now have two states, and every cache reader in both
  runtimes filters on the distinction. A new reader that forgets the predicate
  will serve half-parsed documents as finished, which is why the test asserting
  it names the failure rather than the mechanism.
- `WORKER_PAGE_BATCH_SIZE` is a knob with a real correctness edge: changing it
  invalidates checkpoints in flight. The worker refuses them loudly.
- Chunk boundaries are slightly worse on documents longer than one batch, in a
  way that is documented and bounded.
- A cancelled document is a new terminal state the whole product has to render,
  and rendering it as a failure is the mistake to watch for in review.
