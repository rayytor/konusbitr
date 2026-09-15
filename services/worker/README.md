# konusbitr-worker

The Python half of Konusbitr: fetch, validate, parse, OCR, chunk and embed
documents. FastAPI for health and control, a Redis-stream consumer for the job
loop.

**The parse is real as of Phase 07** and handles born-digital PDFs. A document
is fetched from storage and re-hashed, opened with PDFium for structure and
text-layer coverage, converted by Docling, normalized into the Konusbitr parse
artifact, and written to `parse_results` and `pages` alongside one WebP
thumbnail per page. Phase 08 chunks and embeds what comes out.

**Phases 12.1 and 12.2 read the pages Docling cannot.** A page whose
extractable-text coverage falls below the threshold is not parsed, it is
*recognised*: rendered, deskewed, denoised, binarised and read by an
Apache-2.0 CPU OCR stack, with the preprocessing transform undone before any
box is stored. Phase 12.2 routes that reading by language before the first
page is touched, reconstructs a ruled table from the page's own ruling lines,
and extracts every document's figures — describing them through the vision
role when the upload asked for it with `llm: true`. The VLM tier is
Phase 12.3.

## The parse pipeline

`parse/` is one module per stage, and the split is deliberate — `pipeline.py`
holds the orchestration and every write, so the rules that make an
at-least-once queue safe stay small enough to read in one sitting:

| module              | what it owns                                              |
| ------------------- | --------------------------------------------------------- |
| `storage.py`        | the S3 client: get the object down, put thumbnails back up |
| `inspect.py`        | PDFium: readable, not encrypted, page ceiling, per-page tier |
| `docling_parser.py` | Docling, and the normalization of what it returns          |
| `ocr/`              | the recogniser: seven modules, one job each (below)        |
| `images.py`         | the figures: find them, filter them, store them             |
| `captions.py`       | what a figure says, through the vision role, only if asked  |
| `geometry.py`       | the one coordinate convention, and every conversion into it |
| `thumbnails.py`     | one WebP per page, rendered from the rotated page          |
| `artifact.py`       | the shape everything downstream reads                       |

`parse/ocr/` splits the same way, and the split is what keeps the tier
reviewable:

| module          | what it owns                                                 |
| --------------- | ------------------------------------------------------------ |
| `raster.py`     | PDFium renders the page a reader sees                        |
| `preprocess.py` | deskew, denoise, binarise — **and the affine map back**      |
| `engines.py`    | RapidOCR and Tesseract behind one interface speaking pixels  |
| `languages.py`  | which engine and which dictionary read this document         |
| `layout.py`     | the lines and paragraphs a recogniser discards, either way   |
| `tables.py`     | a ruled table's grid, recovered from the page's own rules    |
| `pipeline.py`   | composition, and the conversion into the coordinate convention |

Two things are worth knowing before changing any of it.

**Coordinates.** PDF points, origin top-left, y downward, rotation already
applied. `docs/coordinates.md` is the specification and `geometry.py` is the
only place anything converts into it. If the Phase 11 viewer ever needs more
than a scale factor, the bug is here.

**A scan is recognised, and a page nothing can read is still refused.** A
standard-tier parse of an image-only PDF succeeds and returns almost nothing,
and a chat built on that answers confidently out of an empty document.
`inspect.py` measures extractable-character coverage **per page** and assigns
each one a `PageTier`: `native` above `TEXT_COVERAGE_THRESHOLD`, `ocr` below
it, so a mixed filing runs both readers over the pages each is right for. The
refusal did not go away; it moved to the two places where it is still the
honest answer — `needs_ocr` when no recogniser is configured and more than a
fifth of the pages are imaged, and `needs_ocr` again when a recogniser ran and
found no words anywhere in the document.

**A document is routed by language, and a line is read by its own
characters.** `settings.langList` wins outright; otherwise `fast-langdetect`
identifies the document from the first page's probe, using the FastText model
bundled inside its own wheel so identification costs no network call. That
route decides which engine is primary. It does *not* decide reading direction:
`layout.is_rtl_text` does, per line, because a Latin page inside an Arabic
filing must not come back with every word correct and every sentence
backwards. `docs/adr/0006-multilingual-tables-figures.md` records why.

**A figure's bounds are the opposite convention and look identical.** PDFium
reports an image *object's* bounds in unrotated page space with a bottom-left
origin, while a rendered page has already had `/Rotate` applied — so
`images.py` normalizes with `origin=bottom_left, rotated=False` and the OCR
tier does not. That is the one trap in this directory worth reading twice.

Docling's layout models are baked into the container image at build time
(`docker/worker.Dockerfile`), so no job ever waits on a model download and
`OFFLINE_MODE` stays honest. Running natively, Docling fetches them to its own
cache on first use.

### Fixtures and the slow suite

`fixtures/pdf/` at the repo root holds the committed corpus, all of it produced
by `fixtures/generate.py` — nothing scraped, nothing copyrighted, and every
expected string is one this repository wrote into the document. Regenerate with:

```bash
cd services/worker && uv run python ../../fixtures/generate.py
```

Run it from the worker's own environment, which already has reportlab, Pillow
and PDFium. The Phase 12.2 fixtures are drawn with Pillow rather than typeset
with reportlab — reportlab does no text shaping, and Arabic laid out without a
shaper is not Arabic — so regenerating them needs a Pillow built against
libraqm. Their fonts are subset and committed under `fixtures/fonts/` by
`scripts/vendor-fixture-fonts.py`, so what the machine happens to have
installed never moves the corpus.

`tests/test_parse_fixtures.py` runs the real parser over that corpus and is
marked `slow`. CI runs it; while iterating, `uv run pytest -m "not slow"` skips
it. Golden markdown lives in `tests/golden/` and is compared after whitespace
normalization — a parser may change how it wraps a line and may not change what
the line says. Rewrite them with `KONUSBITR_UPDATE_GOLDEN=1` and **read the
diff**; a golden file updated without reading the diff is a test switched off.

## Running it alone

```bash
uv sync
uv run pytest
uv run python -m konusbitr_worker    # needs a .env; see .env.example
```

`uv` manages the interpreter as well as the dependencies, so you do not need a
system Python 3.12 — `uv sync` will fetch one. Do not use pip or poetry here;
the lockfile is `uv.lock` and CI installs from it.

Once it is up, `curl localhost:8081/health` reports the job loop and Redis, and
`curl localhost:8081/ready` reports Postgres, Redis and object storage. They
answer different questions and should be wired to different things: `/health`
failing means restart me, `/ready` failing means something I depend on is down
and a restart will not help.

## The boundary

This service never imports TypeScript code and never shares an ORM with the web
app. It receives JSON job payloads over a Redis stream and publishes JSON
progress events back. The pydantic models for those payloads — and the Redis
key names themselves — are **generated** from the Zod schemas in
`packages/shared` into `contracts.py` by `pnpm codegen`. Edit the Zod, run the
codegen, never hand-edit the generated module; CI regenerates it and fails on
any diff.

It does talk to Postgres, in `db.py`, with raw SQL it owns. That is not a
shared data-access layer: Drizzle is the source of truth for the *tables*, and
nothing here imports from `packages/db`.

Document text handled here is untrusted data: it never becomes instructions, it
never drives tool execution, and it never reaches error reporting.

## The pieces

| Module | What it does |
| --- | --- |
| `contracts.py` | **Generated.** Payload models, key names, stage percentages. |
| `settings.py` | The environment, validated at boot. Hand-written. |
| `queue.py` | The Redis stream: read, claim, acknowledge, retry, dead-letter. |
| `runtime.py` | The job loop: concurrency, timeouts, retry classification. |
| `pipeline.py` | The work: one `run_job` for parse, chunk_embed and reindex. |
| `progress.py` | Publishes progress and persists it, because both are needed. |
| `db.py` | The worker's own SQL. Every statement is an upsert. |
| `app.py` | FastAPI: `/health` and `/ready`, and the loop's lifespan. |
| `log.py` | JSON logging with `job_id`, `doc_id` and `org_id` on every line. |

## The transport

A Redis stream, `konusbitr:jobs`, with one consumer group, `konusbitr:workers`.
Not BullMQ and not arq — `docs/adr/0001-queue.md` explains why at length, but
the short version is that neither library's job format can be spoken by the
other's runtime without reimplementing it, and a reimplementation is exactly
the drift this architecture exists to prevent.

Delivery is at-least-once. "Exactly once" is a property of the *writes*: the
parse is an upsert on `(content_hash, settings_hash)`, pages are an upsert on
`(document_id, page_no)`, and the handler short-circuits when the parse it was
about to produce already exists. So a worker killed mid-job and restarted
finishes it without doubling anything.

Retries are three attempts with exponential backoff, parked in
`konusbitr:jobs:retry` and promoted when due. A **terminal** failure — a
corrupt file, an unsupported format, a document that no longer exists — never
spends an attempt; it is dead-lettered immediately, because it will fail
identically every time.

## Configuration

`settings.py` is the pydantic-settings half of the environment contract; the
Zod half is `packages/shared/src/env.ts`, and `.env.example` at the repo root
documents both. It is hand-written on purpose — it is configuration rather than
a wire format, and it has to import before any code generation has run.

The `WORKER_*` variables have no TypeScript counterpart, in the same way
`AUTH_SECRET` has no Python one. `WORKER_NAME` is the one worth understanding:
it is this process's identity in the consumer group, and it must be stable
across restarts and distinct per replica, because a restarted worker reclaims
its own unacknowledged deliveries by name. Unset means the hostname, which is
both of those things under Compose and under Kubernetes.

Both halves fail loudly at boot rather than lazily at first use, and their tests
mirror each other so the two runtimes cannot quietly disagree about what `.env`
means.

## Tests

`uv run pytest` covers the logic: contract round-trips against payloads copied
verbatim from the TypeScript side, retry classification, idempotent
re-delivery, dead-lettering. It needs no containers and takes about two
seconds.

The wiring is proved from the other side, in
`apps/web/test/integration/worker.integration.test.ts`, which starts real
Postgres, Redis and MinIO containers, enqueues from TypeScript, runs this
worker as a child process, and asserts everything from `/ready` to killing the
worker mid-job. Run it with `pnpm test:integration`.
