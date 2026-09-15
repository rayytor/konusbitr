# ADR 0006 — Routing by language, reading tables off their rules, and describing figures

**Status:** accepted (Phase 12.2)

## Context

Phase 12.1 made a scan readable. It made it readable in one language, as prose,
and with whatever was drawn on the page thrown away.

Each of those three is a different kind of loss and they fail differently, which
is why this ADR has three decisions rather than one:

- **Language.** PP-OCRv4's shipped recognition head knows Chinese characters and
  the Latin alphabet. Run it on Arabic and it returns a scattering of plausible
  Latin tokens at *high confidence* — the worst possible failure, because
  nothing downstream can tell it from a reading. Run it on Turkish and it
  returns correct-looking words with every diacritic silently removed.
- **Tables.** A scanned balance sheet flattened into prose keeps every number
  and loses every association. Ask "what were services in 2024?" and retrieval
  finds the passage — every word of the question is on the page — and the model
  then picks a figure out of a row of figures with nothing to bind it to.
- **Figures.** A bar chart is the answer to "which region grew fastest?" and is
  invisible to a text index. The document looks as though it does not contain
  the answer.

## Decision 1: the language is a per-document route, decided before a page is read

`settings.langList` wins outright when it is given. Otherwise the document's
text is identified with `fast-langdetect` and the route is taken from that. The
route decides which engine is *primary* and which dictionary it loads.

**Why `fast-langdetect` rather than `langdetect`.** It is eighty times faster,
which is not the reason. The reason is that it ships its FastText model inside
its own wheel: identification costs no network call, needs no model directory
baked into the image, and works under `OFFLINE_MODE`. That is the same property
that chose `rapidocr-onnxruntime` in Phase 12.1, and it is the only property
that makes a language identifier acceptable in this pipeline at all. The
larger 126MB model is deliberately never requested.

**Why the route is per document rather than per page.** A language identifier
needs text. The only text a scanned page has is the text we are about to
recognise, so a per-page route means a first recognition pass per page to decide
the second — doubling the cost of every scan to serve the rare document that
changes script midway. `langList` is the escape hatch for that document and is
explicit about being one.

**The awkward case, and how it is broken.** A wholly scanned document has no
text at all until something has been recognised. The first page is read with
whatever the default dispatch is, *that* is identified, and the page is re-read
only when the answer turns out to need a different engine. A page therefore
costs double exactly once per document, and only for documents routed away from
the default.

**Why some scripts go to Tesseract even where RapidOCR could try.** Arabic and
Hebrew are contextually shaped and Devanagari composes conjuncts; a detector
plus a CRNN head reconstructs none of that, and Tesseract's LSTM was trained
per-script and does. Turkish and Vietnamese are Latin-script and would *almost*
work on the shipped head, and "almost" here means a silent corruption rather
than a visible failure. Both have a Tesseract pack, installed in
`docker/worker.Dockerfile`.

**Why no model is ever downloaded.** PaddleOCR publishes Japanese, Korean,
Cyrillic, Latin and Devanagari recognition heads, and RapidOCR will happily load
one from a path. Fetching one at run time would put a network call in the middle
of a parse and a hole in `OFFLINE_MODE`. So `OCR_MODEL_DIR` is where an operator
*puts* them, and a language whose head is absent is routed to Tesseract instead.
"Configured" and "installed" are different states and only one of them can read
a page.

### Reading direction is decided per line, not per document

This was got wrong first and the failure is worth recording, because it is not
the shape of failure one expects. With `langList=['ar']` on a document whose
first page is Turkish, the Turkish page came back as `Belge Taranmis Turkce` —
every word recognised correctly and every sentence backwards. It reads as a
recognition failure, embeds as nonsense, and can never be matched by the quote
verifier against anything a model quotes back.

So `is_rtl_text` decides from the characters of each assembled line, by majority
vote over its letters, with the document's route as the tiebreak for a line that
contains none. A majority rather than Unicode's own first-strong rule, because
first-strong reads a *storage* order and the storage order of a line assembled
out of separate word boxes is not a property of the page.

### Both image preparations are read, and the fuller reading is kept

Phase 12.1 handed Tesseract the Sauvola-binarised page and RapidOCR the denoised
greyscale. Phase 12.2 found that neither preparation dominates:

- On `scanned-skewed-photo.pdf` — skewed, unevenly lit — Tesseract reads 75
  words off the binary and **none at all** off the greyscale. That is the whole
  reason the binarisation exists.
- On the Arabic fixture the binary costs a whole line of connected script that
  the greyscale returns cleanly, **at an identical page confidence of 0.92**.
  Sauvola's window erodes hairline strokes, and neither a confidence comparison
  nor a threshold could have seen it.

So an engine declares the preparations it wants, Tesseract names both, and the
better reading is kept — where "better" is *how much was read*, with the
fallback threshold as a floor rather than as the measure. Volume as the
tie-break and confidence as the floor: otherwise a preparation that turns a page
into plausible noise wins by producing more of it.

It costs about a second a page, on the path that is already the slow one.

## Decision 2: a scanned table is reconstructed from its ruling lines, or not at all

Two morphological passes over the binarised page — erode with a long horizontal
kernel, then a long vertical one — leave only strokes that run most of the width
or height of a cell. Their intersections are the grid. A merged cell is read off
the *absent* segment between two adjacent base cells, which is the same
information a reader uses and needs no model.

**Why not Docling's TableFormer.** TableFormer is a good model and it is already
in the dependency set. Driving it here would mean constructing a Docling page
with text cells from OCR output, which is precisely the abstraction ADR 0005
declined to go through — per-page confidence, the deskew transform and word
boxes do not survive it. The grid would come back and the cell boxes would come
back in a frame we could no longer map. Phase 12.3's VLM tier is where a model
reads a scanned page's structure.

**Why only ruled tables.** A table held together by whitespace has no printed
structure to recover, and a column-inference heuristic over word positions is
exactly the kind of thing that works on the fixture and transposes a real
document's columns. Those pages keep the Phase 12.1 behaviour — read as lines of
prose, which is honest and citable even though it is not a table. The corpus
this tier exists for is ruled: balance sheets, invoices, lab reports, clinical
summaries.

**Header detection is per column, not per row.** The obvious rule — "a header
row contains no numbers" — is wrong on the most common table this tier will ever
meet, because the column headings of a financial statement are years. The test
is instead: is there *one* column whose top cell is a label and whose every cell
below is a figure? `Change` over `42%`, `11%`, `7%` is a pattern only a header
produces, and it survives `2023` sitting in the next column along. A table of
nothing but words gets no header at all, which reads as an honest "this parser
could not tell" rather than as a claim that the first row of data names the
columns.

**Words are partitioned, not copied.** A word inside a table's rectangle belongs
to that table and is removed from what the paragraph grouper sees. A number
appearing in both a table chunk and a prose chunk would be retrieved twice and
cited from whichever won, and the two citations would point at different
rectangles.

## Decision 3: figures are extracted always and described only when asked

Extraction is a filter far more than it is an extractor. Three of them, each
removing a different kind of non-figure: under 100 pixels on a side is
decoration; over 90% of the page area *is* the page; and a page in the `ocr`
tier is skipped outright, because a scanned page's one image is the page.
Identical bytes are stored once, because a letterhead appears as an image object
on every page of a document.

Captioning is separate and conditional: it needs `settings.llm` — which is part
of the docId cache key, so a document parsed with captions and the same document
parsed without them are two cache entries rather than one that quietly changed —
**and** a configured vision role. Neither is the default. A figure with no
caption is still extracted, stored and located; it is simply not searchable,
which is a reduced capability rather than a failed job, in exactly the way an
unconfigured embedding model is.

**The caption becomes a chunk of its own**, read out of the artifact's `images`
rather than its `contents`. Two consequences follow and both were wanted. A
`reindex` recreates figure chunks from the cached parse with no model call and
no re-extraction, because the captions are in the artifact. And the chunk
carries the figure's own rectangle, so following the citation puts the reader in
front of the picture the answer came from — which is the only reason to keep it
out of the prose around it.

A Docling `figure` element in `contents` is a different thing that happens to
share a word: it is a picture's caption *as the document printed it*, and it
stays in the prose beside it. The two are kept apart by the caller that knows
which is which rather than by a rule inside the chunker that would have to guess.

## Consequences

- The default image is about 60MB larger, all of it Tesseract language packs.
- A document routed to Tesseract as its primary engine costs roughly a second a
  page more than one routed to RapidOCR, because both preparations are read.
- `OCR_MODEL_DIR` is a documented extension point that the default build does
  not use, and a language whose head is missing degrades to a different engine
  rather than to a worse reading.
- A whitespace-aligned scanned table is still read as prose. That is a known
  gap, it is stated rather than hidden, and Phase 12.3 is where it closes.
- Figures cost storage on every document, whether or not anybody asks about
  them. `FIGURES_ENABLED=false` is the one variable that opts out.

## When to revisit

- If PaddleOCR's multilingual recognition heads are ever published as a
  permissively-licensed Python package that ships its weights, the Tesseract
  route for Japanese, Korean and Cyrillic becomes a fallback rather than the
  primary path.
- If Docling gains a way to run TableFormer over an image and return cell boxes
  in the caller's own frame, Decision 2's narrowing to ruled tables can be
  revisited without giving up the coordinate story.
- Phase 12.3's VLM tier subsumes the unruled-table gap and the heading gap on a
  scan. Both are recorded here so that the trade is visible rather than
  forgotten.
