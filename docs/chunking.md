# Chunking

The rules a retrievable passage is built by, written out — because chunk quality
dominates answer quality more than model choice or prompt wording does, and
because almost every way a chunker can be wrong is a way of losing something the
parse already knew.

Implemented in `services/worker/src/konusbitr_worker/chunk/` and **nowhere
else**. The contracts the rest of the system reads are in
`packages/shared/src/chunk.ts`.

## The shape of a chunk

```
{
  ordinal: 7,
  sectionPath: "Financials > Revenue",
  text: "Financials > Revenue\n\nRevenue grew 18% year over year. …",
  tokenCount: 812,
  pages: [
    { page: 4, bbox: [72, 500, 520, 700] },
    { page: 5, bbox: [72, 90, 520, 310] }
  ],
  meta: { kind: "prose", elementIds: ["el_0031", "el_0032"], tableJson: null, truncated: false }
}
```

`ordinal` is the position in the document and, with `document_id`, the key every
write upserts on. `pages` is one rectangle per page the chunk touches, in the
single coordinate convention of [`coordinates.md`](coordinates.md).

## The rules

### A chunk always knows where it came from

`pages` is `NOT NULL` and never empty. This is the load-bearing rule: a passage
that cannot say which page and which rectangle it came from cannot be cited, and
an answer that cannot be cited is the one thing this product must never produce.

A chunk spanning a page break has an entry for each page. Boxes on the same page
are **unioned**, because a highlight is drawn per page — three paragraphs on page
four are one region to light up, not three overlapping rectangles.

An element the parse could not locate is dropped rather than chunked. A chunk
built from it would be uncitable, which is worse than its absence.

### A table is never split

Half a table answers nothing and cites nothing: the header row and the number
land in different chunks, and whichever one is retrieved is missing the other.

So a table is its own chunk, whatever its size — past the prose ceiling if it
comes to that. It is truncated only when it will not fit in the embedding
model's context at all (8,000 tokens), and then visibly, with
`TRUNCATION_MARKER` in the chunk **text** rather than only in its metadata:
whatever reads the chunk has to be able to tell it is looking at part of a table
rather than all of one.

The table's data travels with it as `meta.tableJson`, so Phase 13's `extract`
can address a cell without re-parsing prose.

### A table interrupts a chunk without interrupting the prose

The paragraphs either side of a table stay in one passage. A financial report
that alternates a sentence with a table would otherwise produce nothing but
fragments.

Prose and tables are therefore chunked as two streams over the same elements and
merged back into reading order before ordinals are assigned.

### A heading of level 1 or 2 ends a chunk — once the chunk is worth ending

A passage that mixes two top-level sections answers questions about neither, and
the retrieval score it gets is the average of two relevances.

But the rule is a means, not an end, and taken absolutely it fights the band:
a document with a heading on every page produces a 255-token fragment per page,
and none of them answers anything. So a boundary flushes once the chunk has
reached the floor, and adjacent sections merge when the alternative is a
fragment. A section larger than the band is split regardless, because it has to
be split somewhere.

This is the one place where two of Phase 08's acceptance criteria pull against
each other, and the resolution is deliberate: respect the hierarchy whenever
doing so produces a usable passage.

### The breadcrumb is part of the text

`Financials > Revenue` is prepended to the chunk's text as well as stored in its
own column. It costs a handful of tokens and measurably improves retrieval,
because a paragraph about "the increase" is about nothing at all once it has left
its page.

Two subtleties. A heading's own `sectionPath` excludes itself, so the chunk that
*opens* a section is labelled with that section rather than with its parent —
otherwise it would be the one chunk in the document with no breadcrumb. And a
chunk that merged sibling sections is labelled with what those sections have in
common, which can be nothing: their own headings are in the chunk's body, so the
context is still in the embedded text, and the breadcrumb stops short of
claiming the whole passage came from the first of them.

### The band is 600–900 tokens, measured in the model's own tokens

Long enough for a passage to answer a question on its own, short enough that
eight of them fit in a prompt with room for an answer.

Counted with the configured embedding model's tokenizer, through the router — a
character count is out by a factor of four in English and out *differently* in
Turkish, and this product is explicitly multilingual. An unrecognised model
falls back to an estimate, logged once.

Two things keep the last chunk in the band rather than leaving an orphan. The
number of chunks is chosen *before* the boundaries, from the total, so 2,455
tokens becomes three chunks of 850 rather than three of 800 and one of 55. And
the target is re-derived after every flush from what is left, because paragraphs
do not divide evenly and a fixed target makes the last chunk pay for every
earlier overshoot.

Chunks below the band still happen, and honestly: a document with less than
600 tokens in it has no banded answer, and one small chunk is the right output.

### 15% overlap, carried as whole elements

So that a sentence straddling a boundary stays retrievable from either side.

Element-level rather than token-level, and that is not an implementation detail:
the repeated elements bring their pages and boxes with them, so a quote a model
draws out of the overlap is still inside the chunk's own rectangles — which is
what mechanical citation verification needs. Where a single paragraph was split
and no whole element fits the budget, a *tail slice* of the last one is carried
instead, keeping that element's box.

The overlap is budgeted out of the ceiling before packing. It used to be added
afterwards, which produced 980-token chunks from a 900-token limit.

### Every write survives a second delivery

Chunks are upserted on `(document_id, ordinal)` and anything past the new count
is deleted. Delivery is at-least-once, so a job killed halfway and redelivered
writes the same ordinals again and must leave one row per ordinal — and a
*re-chunk* that produces forty chunks where there were fifty must leave forty,
not forty new ones and ten stale.

Chunking is deterministic for a given input and configuration, which is what
makes the upsert key stable across that redelivery.

## What is deliberately not here

**Semantic chunking** — embedding sentences and cutting where similarity drops.
It is a real technique and it is measurably better on some corpora, but it costs
an embedding pass before the embedding pass, and the layout signal from Docling
is cheaper and, on documents with real structure, better.

**Per-slice bounding boxes for a split paragraph.** Each part keeps the whole
paragraph's box, because that is the only coordinate the parser produced.
Inventing a tighter one per slice would be a box no parser emitted, which is
exactly what [`coordinates.md`](coordinates.md) forbids. Highlighting the whole
paragraph for a quote inside it is honest; highlighting a guess is not.

**A sentence segmenter.** `_SENTENCE_BOUNDARY` is a crude regex, and
deliberately: a real segmenter is a language-dependent dependency, and what is
needed here is only "a place a reader would accept a break".

## Chunks from a recognised page

Phase 12.1 added a second source of elements, and the chunker treats them
identically — which is the point of the parse artifact, and worth saying
explicitly because one thing about them really is different.

A recognised page produces **paragraphs and ruled tables**, with an empty
`sectionPath`. The OCR tier has no layout model: it knows where ink is and what
it says, and it does not know that a line in larger type at the top of a page is
a heading. A table is the one exception and it is not a guess — the grid was
printed on the page, and Phase 12.2 reads it off the ruling lines rather than
inferring it. A table held together by whitespace alone is still read as prose;
see [`adr/0006-multilingual-tables-figures.md`](adr/0006-multilingual-tables-figures.md).
Guessing would put a claim about the document's structure into the header of
every chunk of every scanned document, and a wrong section path is worse than an
absent one — it is asserted rather than missing, and it is asserted in exactly
the place a retrieved passage uses to say where it came from.

The consequences are real and bounded. A chunk from a scanned page says less
about its context in the chunk header, so retrieval over a scanned corpus is a
little weaker than over a born-digital one. Nothing else changes: the band, the
overlap, the never-split-a-table rule and the `{ page, bbox }` requirement all
apply unchanged, because they are properties of the artifact and not of the
parser that filled it in. Headings on a scan arrive with the VLM tier in Phase
12.3; see [`adr/0005-ocr.md`](adr/0005-ocr.md).

## Chunks from a figure

Phase 12.2 added a **third stream**, and unlike the other two it does not come
out of the artifact's `contents` at all. It comes out of its `images`: every
figure the parse extracted and the vision role described becomes one chunk,
reading

```
[Figure: A bar chart of revenue by region, 2024. North America accounts for
54 percent, Europe for 28 percent and Asia Pacific for 18 percent.]
```

Three properties, each of which is why it is a stream rather than a paragraph.

**It is atomic, for the same reason a table is** — and the reason is the
citation rather than the size. The chunk carries the figure's own rectangle on
its own page, so following the citation puts the reader in front of the picture
the answer came from. Packed in with the prose around it the passage would still
retrieve, and the highlight would land on a paragraph *beside* the figure, which
is a citation that does not survive being checked.

**It has no breadcrumb.** A figure is extracted from the page's object stream
rather than from the element tree, so nothing knows which section it sits under.
An invented heading trail would be the same wrong claim about structure that the
OCR tier declines to make.

**An uncaptioned figure produces no chunk at all.** No vision model configured,
`llm` not set, a provider that failed: there is no text to embed and nothing to
retrieve on. The figure stays in the artifact, in storage and locatable — it is
simply not searchable, which is the honest state rather than an empty passage
diluting the index.

The marker is in the chunk *text* and not only in its metadata, on the same
principle as `TRUNCATION_MARKER`: whatever reads the passage has to be able to
tell that it is reading a description of a picture rather than a sentence
somebody wrote.

One thing that is **not** a figure chunk: a Docling `figure` element in
`contents`. That is a picture's caption as the document printed it, and it
belongs in the prose beside it. The two are kept apart by the caller that knows
which is which rather than by a rule in the chunker that would have to guess.
