# 0007 — The advanced (VLM) tier: grounded, capped, and quarantined

**Status:** accepted (Phase 12.3)
**Supersedes nothing. Extends:** `0005-ocr.md`, `0006-multilingual-tables-figures.md`

---

## Context

The pipeline had two readers by the end of Phase 12.2 and both read *characters*
well. Docling takes a born-digital page's font and layout; the OCR tier takes a
scan's ink and returns words, lines, paragraphs and ruled tables, in four
scripts, with boxes.

Neither reads a *page*. Specifically, neither can say:

- that a three-column newsletter is read column by column rather than line by
  line across the spread,
- that the box in the margin is a sidebar and comes after the body text,
- that a line in 14pt bold is an `h2` and the three paragraphs under it belong
  to it.

Phase 12.1 deferred headings on a scan to this phase explicitly, and said why:
the OCR tier has no layout model, so a heading would be a guess, and a wrong
`sectionPath` is a claim about a document's structure that the document does not
support.

Vision-language models do exactly this. They see the page as a picture, which is
how a person reads one, and the good ones return a bounding box per block. They
also have two properties that make them dangerous as a parser:

1. **They hallucinate characters with total confidence.** A model asked to
   transcribe `1,284,567` will return `1,234,567`. It will do it to a date, a
   case number, a dosage and a party's name, and nothing in the answer marks the
   difference.
2. **They cost money per page.** A 400-page filing against a frontier model is
   a bill, and an uncapped parse path is how a self-hoster discovers that on an
   invoice.

---

## Decisions

### 1. The model owns structure; the text layer owns characters

The tier is **hybrid reconciliation**, not "a better parser". A page goes to the
model, the model returns located blocks in reading order, and then every
character it wrote is checked against — and where they disagree, replaced by —
the characters the page actually contains.

The sources of truth, per page:

| Page tier before the VLM saw it | Reconciliation source |
| --- | --- |
| `native` | The PDF's own text layer, word by word, via PDFium |
| `ocr` | The recogniser's words above `HIGH_CONFIDENCE_OCR_WORD` (0.9) |
| Neither | Nothing. The elements come back `grounded=False` |

The OCR floor is 0.9, far above anything else in the OCR tier, because the role
is reversed: elsewhere a 0.7 word is a word worth keeping, here it is a word
that would be used to *overwrite a different reading of the same ink*, and
correcting one guess with another produces a confident wrong answer out of two
uncertain ones.

**Prose takes the truth outright. A table takes it cell by cell.** Once the
alignment shows the two sources describe the same passage, a paragraph simply
becomes its text layer's tokens — which also recovers whatever the model skipped.
A table cannot do that: the grid is the model's contribution and dissolving the
cells back into a token stream would lose it, so the substitution is positional,
and two asymmetries follow. A token the model invented is **kept** in a table
(deleting it would shorten a cell a header names) and **dropped** in prose. A
token the page has that the model missed is **inserted** in prose and **not**
inserted in a table, because there is no cell to put it in without guessing.
Both are counted, and a table with a large `missing` is one a reader should
look at rather than trust.

#### Why not trust the model and verify afterwards?

Because the verification we already have — the Phase 10 citation verifier — works
against the parse artifact. If the artifact contains the model's hallucinated
digits, a citation quoting them verifies perfectly. The mechanism that catches
model error downstream is blind to model error that got into the corpus. It has
to be fixed at the parse.

#### Why a token diff rather than replacing the whole block?

Below `GROUNDING_FLOOR` (0.5 of the model's tokens finding a home), the thing
that is wrong is the *box*, not the text: it has landed on the wrong column or
half on a neighbour. Replacing then substitutes one real passage for another real
passage — a worse error than an unreconciled one, and far harder to notice,
because both readings are fluent. The diff is what distinguishes the two cases.

### 2. The ceiling is a refusal, and escalation is a cap

Two routes into the tier, deliberately different shapes:

**`quality: "advanced"` reads every page.** What is being bought is
*document-level* structure — a heading hierarchy that holds from the first page
to the last — and reading a subset produces a document whose section paths change
tier half way through. Above `MAX_VLM_PAGES_PER_JOB` (50) the job is **refused**
with `too_many_pages` rather than truncated, at intake and again in the worker.
A parse that reads fifty pages of a four-hundred-page filing has spent the money
the ceiling was meant to save *and* produced a document silently missing seven
eighths of itself.

**A page read below `TIER_FALLBACK_THRESHOLD` (0.6) is escalated.** Nobody asked
for this and nobody is waiting to confirm a price, so it is **capped** rather
than refused — a filing with two hundred illegible pages gets its best fifty
rather than an error.

The threshold sits well under `OCR_LOW_CONFIDENCE_THRESHOLD` (0.85, where the
viewer merely badges a page) because these two numbers do different things: one
warns a reader, the other spends money.

### 3. The estimate is computed twice and must agree

`packages/shared/src/vlm.ts` is the source; `konusbitr_worker/parse/vlm/cost.py`
mirrors it. Hand-mirrored rather than generated, because it does not cross the
Redis seam as a message — but the number a person confirmed and the number an
operator reconciles against the usage log have to be the same number, so
`test_vlm_cost.py` reads the TypeScript constants out of the file and pins them.

Three deliberate choices in the arithmetic:

- **Image tokens are `width × height / 750` after a resample to 1568px on the
  long edge.** That is Anthropic's published formula; OpenAI's tiling and
  Google's fixed tiles land within about a third of it for a page-shaped image.
  Per-provider tiling would be more precise about a quantity whose real variance
  is the document rather than the arithmetic — and the number is presented as
  "about", because it is.
- **The resample cap is what makes the estimate a function of page *count*.** An
  A0 poster and a Letter page arrive at the model as the same pixel budget.
- **A local model is priced `null`, never `0`.** "No charge" and "we could not
  work it out" render identically as `$0.00` and mean opposite things to
  somebody deciding whether to press a button.

The monthly cap is recorded in the credit ledger when the *job is created*,
because that is the last moment at which the number could still prevent a spend.
Reconciling against what the provider actually billed would be accurate and a
month too late. A ledger row rather than a counter column, so an operator asking
why this month's allowance is gone gets a dated list of the documents that spent
it.

### 4. The tier layers on top; it does not replace

Docling and the OCR tier still run on an advanced parse, and their output is the
**fallback** for any page the model could not read — a provider outage, a rate
limit, an answer that was not JSON. A page the model *did* read has the other
readings dropped outright rather than merged: the same paragraph present twice
would be retrieved twice, cited from whichever won, and highlighted at two
slightly different rectangles.

It is also where the reconciliation's evidence comes from. The pass that
produced the fallback produced the located words the model is corrected against,
so the redundancy is not redundant.

### 5. Boxes come back on a 0–1000 scale, `[ymin, xmin, ymax, xmax]`

Which is what Gemini and Qwen2.5-VL emit natively, and therefore the order with
the fewest models to argue with. The parser is lenient about everything else a
provider can do to a JSON contract — a code fence, a sentence of preamble, a
`level` of `"2"`, a 0–1 scale, the transposed axis order — and completely strict
about geometry: **an element whose box cannot be resolved to a rectangle on the
page is dropped.** An element that cannot be pointed at cannot be cited, and an
uncitable answer is the failure this product exists to prevent.

No `response_format` is sent. LiteLLM emulates JSON mode differently across the
providers this router fronts and ignores it on several, so a parser that copes
with prose was needed regardless — and once it exists, the flag buys nothing but
a provider-specific failure mode.

The conversion is `origin=top_left, rotated=True`: the model saw the page PDFium
rendered, and PDFium applies `/Rotate`. Exactly the OCR tier's call, for exactly
the OCR tier's reason, and the **opposite** of `parse/images.py`, where PDFium
reports an object's bounds in unrotated space. `docs/coordinates.md` names this
trap; this is the third module to fall into it and the third to be written
against it deliberately.

### 6. Table cells get no boxes from the model

`TableData.cells` is empty for a VLM table. A vision model asked for a rectangle
per cell returns a plausible grid of rectangles that drift by several points
each, and a citation landing one row off a financial table is worse than one
that highlights the whole table honestly. `headers` and `rows` are the contract
and Phase 13's `extract` addresses them without needing geometry.

### 7. Ollama's vision default becomes Qwen2.5-VL

Phase 12.2 defaulted `ollama` to `llama3.2-vision`, which is correct for
captioning a figure and wrong for this. Reading a page into structured elements
needs a model trained for document grounding that **returns coordinates**.
Qwen2.5-VL does; Llama 3.2 Vision describes an image and does not. A local
deployment asking for `advanced` against a model that cannot return a box would
get an empty parse rather than an error — the failure mode this project refuses
everywhere else.

### 8. Licensing: two locks, not one

The AGPL and GPL parsers (PyMuPDF, Surya) are:

1. **entirely outside the project's dependency resolution** — pinned in
   `docker/advanced-requirements.txt`, absent from `pyproject.toml` and from
   `uv.lock`; and
2. installed only by the `worker-advanced` Dockerfile stage, which is reachable
   only through the Compose `advanced` profile.

The first of those was an `[project.optional-dependencies]` extra until it could
not be. Both packages pin `pillow<11`, `pillow>=11` is a runtime dependency of
the default build, and uv resolves extras together with the base dependency set
— so as an extra they made the default resolution unsatisfiable, and the only
ways out would have been to downgrade Pillow in the Apache-2.0 image or to
loosen its pin. **An optional, quarantined, never-installed package would have
decided what the image everybody runs ships.** That is the quarantine leaking in
the one direction it must never leak, and it is why the pins live in a
requirements file that nothing but one Dockerfile stage reads.

Marker is not installed even there: GPL-3.0 *plus* a commercial-use restriction
on its hosted weights is not an open-source licence but a use restriction an
operator must evaluate for themselves, and it fetches a model set at first use,
which would make the advanced image a network dependency in a project whose
`OFFLINE_MODE` is a headline claim.

The stage **fails the build** when `ENABLE_ADVANCED_PARSERS` is not `true`,
rather than quietly producing an image identical to `runtime`. A silent no-op
would let somebody target the stage, get a clean image, believe they had the
advanced parsers, and discover at the first document that they did not. A licence
boundary that can be crossed by accident is not one — and neither is one that can
be *missed* by accident.

`docs/licensing.md` is the full accounting; `pnpm audit:licenses` and
`tests/test_licensing.py` are the enforcement, and they audit the **installed
environment** rather than the lockfile, because a restrictively-licensed package
almost always arrives as somebody else's transitive dependency.

---

## Consequences

**A born-digital advanced parse is character-exact by construction.** Every token
in a reconciled prose block came out of the PDF's text layer. That is the
acceptance criterion, and it is met by replacement rather than by measurement.

**A scanned advanced parse is only as exact as the recogniser was confident.**
Pages where OCR was poor — which are precisely the pages escalation sends — have
little truth to reconcile against, and their elements are flagged
`grounded=False`. This is the honest answer and it is visible rather than
implied.

**The advanced tier is unavailable in the default `.env`,** which configures no
vision role. `quality: "advanced"` is refused at intake with a message naming
`VISION_PROVIDER` and `VISION_MODEL`. That is deliberate: silently downgrading
to a standard parse under an `advanced` settings hash would poison the docId
cache with a standard parse that a later, properly-configured upload would be
handed.

**The `advanced` Compose profile replaces the worker rather than joining it.**
Both consume the same Redis consumer group, so running both would split jobs
between an image that has the restrictively-licensed parsers and one that does
not — and a document would be parsed differently depending on which container
claimed it. Hence `WORKER_REPLICAS=0`, which is two settings instead of one and
is the honest cost of the quarantine.

**Phase 12.3 wires the licence boundary and not a pipeline through it.** Nothing
in the default tiers needs a copyleft dependency, and `parse/advanced.py` is the
seam a later phase reaches through. The audit is what keeps that seam from
quietly becoming the default.
