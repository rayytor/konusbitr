# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state of this repository

**Phases 01–11 and 12.1–12.2/4 are done; Phase 12.3/4 is next.** `cp .env.example .env &&
docker compose up` brings up the whole stack, and the repo installs, builds,
lints, typechecks and tests on both runtimes. The database schema is complete,
every request into the app resolves to an authenticated principal scoped to one
organization, and documents can be uploaded (direct-to-storage presigned PUTs),
imported from URLs (with SSRF protection), listed, read, and deleted. The docId
cache is live: re-uploading the same file returns the same document in
milliseconds with zero cost and no job. **Both runtimes now run**: a job
enqueued by TypeScript is consumed by the Python worker, which walks the
document from `queued` to `ready` and publishes progress the browser reads over
SSE. **The parse is real as of Phase 07** — a born-digital PDF comes back as
markdown plus a `contents` array in which every element has a page number and a
bounding box, tables survive as markdown *and* as JSON, and every page has a
WebP thumbnail in storage. A scan is refused with `needs_ocr` rather than parsed
into silence. **Phase 08 makes it retrievable**: a parse artifact becomes chunks
that each carry their page and bounding box, no table is ever split, and every
model call — cloud or local — goes through one router whose four roles are
configured independently. **Phase 09 retrieves**: `retrieve()` runs a dense
pgvector search and a Postgres full-text search, fuses the two ranked lists with
RRF, reranks, and returns eight chunks with their page and bounding box intact —
in document or corpus scope, always org-filtered, never more than three chunks
from one document. **Phase 10 answers with verified citations**: `POST /api/chat`
streams grounded answers via Vercel AI SDK v5 `streamText` through the router, cites
every claim with `[[chunk_id, page]]` and trailing structured citations with page and bbox,
mechanically verifies every citation against chunk and page text (exact + fuzzy matching)
and drops unverifiable claims, refuses absent questions cleanly, and resists adversarial
prompt injection. Multi-turn chat is supported with query rewriting, conversation CRUD is
org-scoped, auto-titling runs asynchronously, and `pnpm eval:chat` validates citation accuracy
(≥98%), faithfulness, and refusal rates. **Phase 11 is the product**: the
viewer, the chat pane and the workspace that joins them, where a citation is
clicked and the sentence lights up on the page.

**Phase 12.1/4 reads scans.** The `needs_ocr` refusal is now a *tier*: every page
is classified by its extractable-text density, Docling reads the born-digital
ones and an Apache-2.0 CPU OCR stack — RapidOCR under `onnxruntime`, with
Tesseract as a fallback — reads the rest. A mixed document runs both over the
pages each is right for. Pages are deskewed, denoised and binarised before
recognition and the transform is **undone** before any box is stored, so a
recognised box lands in the same coordinate convention as a parsed one. Every
page carries its `tier` and, where something guessed, an `ocr_confidence` the
viewer badges from. A document the recogniser cannot read is still refused
rather than parsed into silence.

**Phase 12.2/4 reads scans in other languages, as tables, and with their
pictures.** Three things, and each removes a different silent loss.

A document is now **routed before it is read**: `settings.langList` wins
outright, and otherwise `fast-langdetect` identifies the document's text —
using the FastText model bundled inside its own wheel, so identification costs
no network call and works under `OFFLINE_MODE`. The route decides which engine
is primary, so Arabic and Hebrew and Turkish and Japanese go to Tesseract's
language packs while Latin and Chinese stay on PP-OCRv4's shipped head. Reading
*direction* is decided per line from the line's own characters rather than from
the route, because a Latin page inside an Arabic document must not come back
with its sentences reversed. Both image preparations are read where an engine
wants both, because neither dominates: the binarisation is the only thing that
makes a shadowed photograph readable and it erodes the hairline strokes of
connected scripts, at an identical page confidence.

A **ruled table on a scanned page is reconstructed from its own ruling lines**
and comes back as a `table` element with markdown, `headers`, `rows` and
cell-level boxes — merged cells included, read off the rule that is *not* there.
A table held together by whitespace alone is still read as prose, which is
stated rather than hidden.

**Figures are extracted from every document** — filtered to remove the
letterhead, the rule and the page-sized scan, deduplicated, and stored under
`orgs/{orgId}/documents/{docId}/images/{n}.png`. When an upload asks for it with
`llm: true` *and* a vision role is configured, each one is described through the
router and that description becomes a chunk of its own carrying the figure's
rectangle — so a question only a bar chart can answer retrieves the bar chart.
`docs/adr/0006-multilingual-tables-figures.md` records all three decisions.

One thing to know before touching the pipeline: **with no embedding model
configured — which is the default `.env` — chunks are written without vectors.**
That is a supported state, not a half-finished one. The passages are stored and
keyword-searchable, and `POST /api/documents/:id/reindex` fills the vectors in
once a model is named. It is the same shape as `SMTP_URL` being unset, and it is
what keeps `docker compose up` a stack that finishes a job rather than one that
needs an API key first. A role that *is* configured and then fails is a hard
job failure; that distinction is the one that matters.

What exists:

- `docker-compose.yml` + `docker/` — Postgres 17 with pgvector, Redis, MinIO
  (bucket and dev access key created automatically), a `migrate` one-shot that
  applies the migrations before web and worker start, the web image and the
  worker image, plus the `local-llm` profile for Ollama. `advanced` is declared
  and deliberately empty until Phase 12.3. The worker image carries Tesseract
  and the language packs the Phase 12.2 routing sends documents to; adding
  another language is one line in `docker/worker.Dockerfile`.
- `apps/web` — Next.js 15 with the sepia theme tokens. Better Auth on the
  Phase 03 tables: email + password with verification, magic links, optional
  Google and GitHub, and the organization plugin. `src/lib/auth/` owns the
  `AuthContext` resolver and the `withAuth` wrapper every protected route goes
  through; `/login`, `/signup`, `/accept-invitation/:id`, `/settings/api-keys`
  and `/settings/members` are the Phase 04 surfaces. Phase 05 adds the intake
  API (`/api/uploads/presign`, `/api/uploads/complete`, `/api/documents`,
  `/api/documents/:id`, `/api/documents/from-url`) and a minimal library page
  (`/library`) with drag-and-drop upload, URL import, status badges, and
  deletion. `src/lib/ingest/` owns the intake pipeline: SSRF guard, PDF
  validation (magic bytes, encryption, bomb detection), streaming SHA-256
  hashing, the docId cache resolver, and `queue.ts`, which appends the job to
  the Redis stream. Phase 06 adds `/api/documents/:id/events` (SSE progress —
  subscribe, replay from the `jobs` row, then flush, so a mid-parse refresh
  resumes) and `/api/admin/jobs/failed` (the operator view of failed jobs and
  the dead-letter list; owner-only and closed to API keys).
  `src/lib/upload-client.ts` is the browser-side uploader (XHR
  direct-to-storage, multipart above 16MiB, progress events);
  `src/lib/use-document-progress.ts` is the `EventSource` hook the library page
  watches with. Phase 08 adds `POST /api/documents/:id/reindex`, which re-chunks
  and re-embeds a document from the cached parse without re-running Docling —
  what an operator runs after changing `EMBEDDING_MODEL` — and puts
  `chunksReady`/`chunksTotal`/`embeddingModel` on `DocumentView`. Standalone
  output for the container; env validated at boot from `src/instrumentation.ts`.
  No chat yet (Phase 10+); retrieval lives in `packages/retrieval`.
- `packages/storage` — the S3-compatible object store client (AWS SDK v3).
  `presignPut`, `presignGet`, `head`, `delete`, `deletePrefix`, `streamGet`,
  `uploadStream`, `presignMultipart`, `completeMultipart`, `abortMultipart`.
  Key layout: `orgs/{orgId}/documents/{docId}/original.{ext}` — keys are
  derived from generated ids, never from user input. Unit and Testcontainers
  integration-tested against real MinIO.
- `packages/shared` — the Zod contracts (`Citation`, `DocumentStatus`,
  `ParseSettings`) plus `upload.ts` (intake request/response schemas, MIME
  allowlist, filename sanitization) and `env.ts`, the TypeScript half of the
  environment contract. `job.ts` and `queue.ts` are the cross-runtime job
  contract — `JobPayload`, `JobProgress`, the stage and error-code
  vocabularies, `STAGE_PERCENT`, and the Redis key names — and
  `scripts/emit-contract.ts` turns them into the JSON Schema and the constants
  that `pnpm codegen` generates the worker's `contracts.py` from. Phase 08 adds
  `chunk.ts` (`ChunkPage`, `ChunkMeta`, `CHUNKING_DEFAULTS`, `unionChunkPages`)
  and `models.ts` (`MODEL_ROLES`, the local/cloud provider partition,
  `EMBEDDING_DIMENSIONS`) — neither crosses the Redis seam, so neither is
  generated; the Python side mirrors them and both halves assert the shape.
- `services/worker` — a Python 3.12 package under uv, pytest and ruff green.
  FastAPI serves `/health` (the job loop plus Redis) and `/ready` (Postgres,
  Redis, storage) on `WORKER_PORT`; the consumer loop runs inside the app's
  lifespan. `contracts.py` is generated and must never be hand-edited;
  `queue.py` owns the stream, `runtime.py` the loop (concurrency, per-job
  timeout, retry classification, dead-lettering), `db.py` the worker's own raw
  SQL, `parse/` the Docling pipeline, `parse/ocr/` the OCR tier,
  `parse/images.py` and `parse/captions.py` the figure extraction and its
  captions, `chunk/` the layout-aware chunker and the batched embed-and-upsert,
  `ai/` the LiteLLM router (role resolution, offline enforcement, retries,
  circuit breaker, the tokenizer the chunker measures with, and `vision.py` for
  figure captions), and `pipeline.py` the coordination — one `run_job` for
  `parse`, `chunk_embed` and `reindex`, differing only in which short-circuits
  apply. `parse/ocr/` is seven modules with one job each: `raster.py` renders
  with PDFium, `preprocess.py` deskews, denoises and binarises *and keeps the
  affine map back*, `engines.py` is RapidOCR and Tesseract behind one interface
  speaking pixels, `layout.py` rebuilds the lines and paragraphs a recogniser
  discards in either reading direction, `languages.py` decides which engine and
  which dictionary read a document, `tables.py` recovers a ruled table's grid
  from the page's own rules, and `pipeline.py` composes them and converts into
  the coordinate convention. It has no layout model, so it emits paragraphs and
  ruled tables and no headings — headings on a scan are Phase 12.3; see
  `docs/adr/0005-ocr.md` and `docs/adr/0006-multilingual-tables-figures.md` for
  why those trades were taken.
- `packages/db` — the complete Drizzle schema (17 tables, auth included),
  migrations, the `scopedDb(orgId)` multi-tenancy helper with document CRUD
  queries (`listDocuments`, `documentById`, `documentByHashes`,
  `createDocument`, `deleteDocument`), job queries (`latestJobForDocument`,
  `listFailedJobs`) and `chunkCounts`, `newId(prefix)`, the migration runner
  (`pnpm db:migrate`) and the seed script (`pnpm db:seed`).
  `packages/db/src/queries/documents.ts` has the unscoped
  `globalParseResultByHashes` for `ALLOW_GLOBAL_PARSE_CACHE`. Integration-tested
  with Testcontainers against real Postgres with pgvector.
- `fixtures/` — the PDF corpus, every file produced by `fixtures/generate.py`
  and nothing scraped: a clean 10-page document, a 50-page budget fixture, a
  table-heavy report, a two-column paper, a rotated A4 document, an image-only
  scan, an encrypted PDF and a truncated one. Phase 12.1 adds four scanned
  fixtures, and they are *rasters of real glyphs* rather than grey bars: a clean
  Letter scan, one page at each of `/Rotate` 90/180/270, a page photographed at
  three and a half degrees under a lamp, and a ten-page filing with seven
  digital pages and three photocopies. Each is typeset with reportlab, rendered
  with PDFium and degraded deterministically, so the tests can assert what the
  page *says* rather than record what the recogniser returned. Phase 12.2 adds
  three more: a four-page scan with one script per page (Turkish, Arabic,
  Chinese, Japanese), a scanned ruled financial statement whose second page has
  a merged header cell, and a born-digital report carrying one real bar chart
  plus the logo and rule the extraction filters must remove. Those three are
  drawn with Pillow rather than typeset with reportlab, because reportlab does
  no text shaping and Arabic laid out without a shaper is not Arabic; their
  fonts are subset and committed under `fixtures/fonts/` by
  `scripts/vendor-fixture-fonts.py`, so regeneration does not depend on what the
  machine happens to have installed. Regeneration is byte-stable, so a diff on
  those files means the corpus actually moved. The 500-page monster is generated
  at test time rather than committed.
- `docs/coordinates.md` — the coordinate convention, written out: the
  conversions, the rotation table, and what is deliberately *not* in it.
- `docs/chunking.md` — the rules a chunk is built by, including the two places
  where Phase 08's own acceptance criteria pull against each other and how that
  was resolved.
- `docs/adr/0001-queue.md` — why the TypeScript ↔ Python transport is a Redis
  stream with a consumer group rather than BullMQ or arq, and when to revisit
  that.
- `docs/adr/0002-model-router.md` — why every model call goes through LiteLLM in
  the worker and `packages/ai` on the product surface, why the four roles are
  configured independently, and why the embedding width is fixed at 1024.
- `docs/adr/0005-ocr.md` — why pages are tiered individually, why the OCR
  engines are driven directly rather than through Docling (per-page confidence,
  the deskew transform and word boxes do not survive its text-cell
  abstraction), and why RapidOCR is primary with Tesseract as a genuinely
  different fallback.
- `docs/adr/0006-multilingual-tables-figures.md` — why the language route is a
  per-document decision but the reading *direction* is a per-line one, why both
  image preparations are read when an engine wants both, why a scanned table is
  reconstructed from its ruling lines rather than through Docling's TableFormer,
  and why figures are extracted always and captioned only on request.
- `docs/adr/0003-retrieval.md` — why fusion is RRF over ranks rather than
  normalized scores, why the sparse leg ORs its terms and drops function words
  first, why `hnsw.ef_search` has to be set with `SET LOCAL` inside the query's
  own transaction, and what the eval is allowed to claim.
- `packages/ai` — the TypeScript half of the model router: role resolution,
  offline enforcement at the call site, retry with full jitter, a per-role
  circuit breaker, usage accounting, and embeddings over the OpenAI-compatible
  route. `prompts/` is where every prompt will live, as a versioned file.
- `packages/retrieval` — the retrieval service. `retrieve()` is the entrypoint;
  `dense.ts` and `sparse.ts` are the two legs, `fusion.ts` is RRF at k=60,
  `rerank.ts` the cross-encoder stage (a pass-through when no rerank model
  resolves, which is a supported state), `diversity.ts` the three-per-document
  cap, `two-stage.ts` the summary-first path for corpora past
  `CORPUS_TWO_STAGE_THRESHOLD`, and `stopwords.ts` the query-side function-word
  list without which the sparse leg matches the entire corpus. `testing.ts`
  exports a deterministic hashing embedder so the SQL can be exercised with no
  provider key. `docs/adr/0003-retrieval.md` records the decisions, including the
  two bugs that only real SQL could have caught.
- `evals/` — the golden set and the harness. `extract-pages.py` dumps the fixture
  PDFs' real per-page text; `generate-golden.ts` builds 205 questions from it and
  **refuses to write a question whose evidence appears in no page of its
  document**; `src/eval-retrieval.ts` starts a Postgres, indexes the corpus and
  scores the real `retrieve()`; `src/benchmark-latency.ts` measures p95 over
  100k chunks. `RESULTS.md` is the recorded baseline and says plainly what the
  numbers do and do not cover.
- `packages/sdk`, `apps/extension` — placeholders whose READMEs name the phase
  that fills them in.

The specifications remain authoritative for everything not yet built:

- `design.md` — the complete UI/visual design specification.
- `phases/01..15-*.md` — a 15-phase implementation plan. Each phase file is
  self-contained (context, scope, non-goals, acceptance criteria) and assumes
  every earlier phase is merged and green.
- `phases/README.md` — the phase index and cross-cutting conventions. It links
  `../implementation_plan_1.md`, which does not exist — the phase files are the
  authoritative plan.

Work here means **implementing a phase**. Read the phase file first and treat its
acceptance-criteria checklist as the definition of done; do not skip ahead to a
later phase's scope (each file has an explicit non-goals section).

## What Konusbitr is

An open-source, self-hostable alternative to PDF.ai: upload documents, chat with
them, get answers with **clickable page-accurate citations**, and drive the whole
thing through a PDF.ai-wire-compatible `/v2` REST API.

Milestones: **Phase 11** = usable product (MVP ships). **Phase 13** = usable API
platform. **Phase 15** = complete alternative, `v1.0.0`.

## Architecture

### Two runtimes, one hard seam

TypeScript owns the product surface (web app, API, auth, billing) because the
streaming-chat-UI ecosystem lives there. Python owns the document pipeline because
every serious PDF layout/OCR library (Docling, PaddleOCR, Surya) is Python.

**The entire contract between them is a Redis stream plus JSON payloads** — no
shared ORM, no RPC framework, no imports across the boundary. Never add a
cross-language import or a shared database access layer; that seam is what keeps a
two-language codebase contributable. (The worker does read and write Postgres,
with raw SQL it owns in `services/worker/src/konusbitr_worker/db.py`. That is
not a shared access layer: Drizzle owns the *tables*, and nothing in the worker
imports from `packages/db`.)

The Zod schemas in `packages/shared` are the source of truth for the job payload
**and for the Redis key names**; the pydantic models and the key constants are
both **generated** into `konusbitr_worker.contracts` via `pnpm codegen`, and CI
fails on drift. Contract drift is the main failure mode of this design — and a
queue name that drifts is worse than a field name, because everything looks
healthy and nothing happens.

`docs/adr/0001-queue.md` records why the transport is a hand-rolled Redis stream
with a consumer group rather than BullMQ or arq.

### Planned layout

```
apps/web           Next.js 15 App Router, React 19, Tailwind v4, shadcn/ui
apps/extension     WXT Chrome extension (Phase 15)
services/worker    Python 3.12, FastAPI + arq, package konusbitr_worker
packages/db        Drizzle schema, migrations, client
packages/shared    Zod v4 schemas + inferred types (cross-boundary source of truth)
packages/storage   S3-compatible client (MinIO/S3/R2/B2)
packages/ai        LiteLLM model router + versioned prompt files
packages/retrieval Hybrid search, RRF fusion, rerank
packages/sdk       Generated TS client (Phase 13)
docker/            Dockerfiles + compose fragments
evals/             Golden set + eval harness results
docs/              Docs site, ADRs, coordinates.md, licensing.md
```

### The data flow

```
upload (presigned PUT, direct to storage — never through the Next.js server)
  → content_hash + settings_hash → docId cache check
  → XADD parse job onto the konusbitr:jobs stream
  → worker: fetch → validate → text-coverage tier → Docling parse
           → normalize to parse artifact → persist parse_results/pages/thumbnails
  → chunk (layout-aware) → embed → upsert pgvector
  → progress published to konusbitr:progress:{documentId}
  → browser reads progress over SSE at /api/documents/:id/events
```

Query path: `retrieve()` → dense (pgvector HNSW) + sparse (Postgres `tsv`) → RRF
fusion (k=60) → cross-encoder rerank → top 8 → prompt → `streamText` → citation
extraction → **mechanical quote verification** → client.

### Load-bearing invariants

These cut across many files; violating one breaks the product rather than one feature.

- **The docId cache is architecture, not optimization.** Cache key is
  `sha256(file bytes)` + `sha256(canonical_json({quality, langList sorted, llm}))`,
  enforced by a `UNIQUE (content_hash, settings_hash)` constraint on
  `parse_results`. A repeat upload must return `ready` in milliseconds with zero
  credits and no job. Cross-org reuse is **off by default**.
- **One coordinate convention:** PDF user-space points, origin **top-left**, y
  increasing downward, unrotated page. The worker normalizes Docling/OCR output
  into it and applies page rotation; `pages` stores width/height. The viewer then
  only applies a scale factor — if the viewer needs more than that, fix the
  worker, not the viewer. Documented in `docs/coordinates.md`, implemented in
  `services/worker/src/konusbitr_worker/parse/geometry.py` and **nowhere else**.
  The OCR tier reaches it by a shorter route and adds no arithmetic of its own:
  PDFium renders the page a reader *sees*, so a pixel is already in the visible
  frame and the conversion is `× 72/dpi` plus `normalize(rotated=True)`. The one
  thing that path must never skip is undoing the deskew — recognition happens on
  a straightened page and storage happens on the page as it exists, and
  `Preprocessed.to_source` is the bridge. **The figure path is the opposite and
  looks identical**, which is the trap: PDFium reports an image *object's*
  bounds in unrotated page space with a bottom-left origin, so
  `parse/images.py` normalizes with `origin=bottom_left, rotated=False` and the
  rotation table is what turns it. A rendered page has had `/Rotate` applied;
  an object's bounds have not.
- **A page the standard tier cannot read honestly is recognised, not parsed —
  and a page nothing can read is refused.** A scan has no text layer; parsing it
  anyway returns almost nothing and a chat built on that answers confidently out
  of an empty document. `inspect.py` measures extractable-character coverage
  **per page** and assigns each one a `PageTier`: `native` above
  `TEXT_COVERAGE_THRESHOLD`, `ocr` below it. The OCR tier reads the `ocr` pages.
  The refusal did not go away, it moved to the two places where it is still the
  honest answer: `needs_ocr` when no recogniser is configured and more than a
  fifth of the pages are imaged, and `needs_ocr` again when a recogniser ran and
  found no words anywhere in the document. Never let a document reach `ready`
  with nothing in it.
- **Citations are verified mechanically before they reach the client.** Every
  quote must actually appear in the parse result for the page it cites
  (exact match, then fuzzy for hyphenation/ligature noise). Unverifiable citations
  are dropped and logged; the rejection rate is a health metric. Target citation
  accuracy ≥ 98% (≥ 95% on scans).
- **A chunk always knows where it came from.** `chunks.pages` is `NOT NULL` and
  never empty: one `{ page, bbox }` per page the chunk touches, in the one
  coordinate convention. A passage that cannot say where it came from cannot be
  cited, and an uncitable answer is the failure this product exists to prevent.
  Implemented in `services/worker/src/konusbitr_worker/chunk/` and documented in
  `docs/chunking.md`.
- **A document is routed by language before a page of it is recognised, and the
  reading direction is decided per line.** The two are separate on purpose.
  `settings.langList` or `fast-langdetect` chooses which engine is primary and
  which dictionary it loads, once per document, because a language identifier
  needs text and the only text a scan has is what is about to be recognised.
  Direction is not that question: a Latin page inside an Arabic filing must read
  left to right, so `layout.is_rtl_text` decides from each line's own characters
  with the document's route only as the tiebreak. A document-level flag returned
  a Turkish page with every word correct and every sentence backwards, which
  reads as a recognition failure and can never be matched by the quote verifier.
- **A table is never split.** Half a table cites nothing — the header row and
  the number land in different chunks. An oversized table is its own chunk, past
  the prose ceiling if it must be, and is truncated only when it exceeds the
  embedding model's context, visibly, with a marker in the chunk *text*.
- **Chunks are upserted on `(document_id, ordinal)`, and anything past the new
  count is deleted.** Both halves are needed: the upsert is why a re-delivered
  embed job leaves one row per ordinal, and the prune is why a re-chunk that
  produces forty chunks where there were fifty does not leave ten stale rows
  with stale vectors that retrieval would happily return.
- **The embedding width is 1024 and it is in the DDL.** pgvector cannot build an
  HNSW index over a column whose dimension it does not know, so
  `chunks.embedding` is `vector(1024)` — never untyped — and the worker refuses
  to write a vector of another width rather than letting a batch insert fail
  inside Postgres. Changing it is a migration *and* a reindex of every document,
  because a mixed index does not fail: it silently returns cosine distances
  between two unrelated spaces.
- **Tenancy:** `org_id` is denormalized onto `chunks` so retrieval never joins to
  filter. Every query path goes through `scopedDb(orgId)`; every route through
  `withAuth`. Both are backed by tests that fail when a new route or query
  bypasses them — `apps/web/test/auth/protected-routes.test.ts` walks
  `src/app/api` on the filesystem, so adding an unwrapped route turns it red.
  The handful of queries that genuinely cannot be scoped (authenticating an API
  key discovers the org rather than asserting it) live together in
  `packages/db/src/queries/`.
- **Auth is Better Auth, mapped onto our tables, not its own.** `user` →
  `users`, `member` → `memberships`, the organization plugin's
  `organizationId` → our `org_id`. The Drizzle adapter resolves those names by
  *string* at runtime, so a mismatch typechecks cleanly and fails at sign-in —
  which is why `apps/web/test/integration/auth.integration.test.ts` runs a real
  instance against real Postgres and Redis.
- **`NODE_ENV` never decides security behaviour; `APP_URL` does.** Whether
  cookies get `Secure`, and whether the development `AUTH_SECRET` is tolerated,
  follow the origin. The Compose web container is a production Next.js build
  serving plain HTTP on localhost, and a browser silently discards a
  `__Secure-` cookie that did not arrive over HTTPS.
- **A retrieval leg that fails is reported; two that fail raise.** A leg
  returning nothing is ordinary — a corpus with no vectors yet is a supported
  state. A leg *throwing* is a bug, and `.catch(() => [])` around one is how a
  dense query that could not run became silently keyword-only retrieval that
  still looked healthy for an entire phase. Failures reach the caller through
  `onLegError`, and when every leg fails `retrieve()` raises rather than
  returning `[]`, which would read as "no matches".
- **The sparse leg's stop words are applied to the query and never to the
  index.** `chunks.tsv` uses the `simple` configuration precisely so that no
  token is stripped and an exact search for a rare string still works. The query
  is the opposite case: it is mostly function words, the leg ORs its terms, and
  a query containing "the" matches the whole corpus — measured at 98,485 of
  100,000 chunks and 1269ms p95, against a 400ms budget. See
  `packages/retrieval/src/stopwords.ts`.
- **The eval runs the real `retrieve()` against a real Postgres.** It is allowed
  to measure the retrieval machinery and is not allowed to claim anything about
  embedding quality, because it embeds with a deterministic hashing vectorizer so
  that CI needs no provider key. A harness that simulates its own retrieval
  measures the simulator; an earlier version of this one did exactly that and
  reported 98.10% recall from arithmetic on a fabricated ranking. Every golden
  question is grounded in text that is actually in its document, enforced by the
  generator.
- **All model calls go through the router.** LiteLLM in the worker
  (`konusbitr_worker.ai`), `@konusbitr/ai` on the product surface. Never import a
  provider SDK directly. Roles (`chat`, `embedding`, `rerank`, `vision`) are
  configured independently and each falls back to `LLM_PROVIDER`.
  `OFFLINE_MODE=true` is enforced **twice** — at boot, where a cloud provider
  named for any role fails the process, and again at every call site, because
  configuration can change under a running process. It is a headline claim and
  is tested from both sides. See `docs/adr/0002-model-router.md`.
- **Prompts live in versioned files** under `packages/ai/prompts/`, never inline
  string literals, so an eval score change can be attributed to a prompt change.
- **A figure is extracted from every document and described only when asked.**
  Extraction is unconditional and is mostly a *filter* — under 100px is
  decoration, over 90% of the page is the page, a recognised page's one image is
  the page, and identical bytes are stored once. Captioning needs
  `settings.llm`, which is part of the docId cache key, *and* a configured
  vision role; neither is the default, and an uncaptioned figure is stored and
  located but produces no chunk, because a passage with no text dilutes the
  index. It is the one path that sends document *pixels* anywhere.
- **Document text is untrusted data.** It never becomes instructions, never drives
  tool execution, and never reaches Sentry.
- **Ids are prefixed ULID-ish strings** (`doc_…`, `chk_…`, `org_…`, `key_…`) via a
  `newId(prefix)` helper. Storage keys are derived from generated ids, never from
  user input.
- **Fail loudly at boot** on missing/malformed env — Zod on the TS side,
  pydantic-settings on the Python side. Never lazily at first use.
- **No WebSockets anywhere.** Progress and streaming use SSE. The progress
  endpoint subscribes to Redis *before* it replays the `jobs` row, and holds
  what arrives in between — reading the row first leaves a window in which a
  job finishes and publishes to nobody.
- **Delivery is at-least-once; "exactly once" is a property of the writes.**
  Every write the worker makes is an upsert, and the parse handler
  short-circuits when the parse it was about to produce already exists. A job
  re-delivered after a crash must be a no-op. Never add a write to the worker
  that a second delivery would duplicate.
- **A terminal failure never spends a retry.** `JOB_ERROR_CODES` in
  `packages/shared/src/job.ts` divides the codes; a corrupt file is
  dead-lettered on the first attempt, a Redis blip gets three with exponential
  backoff. An unrecognised exception is `internal`, which is *retryable* — the
  safe default, because wrongly marking a document permanently failed costs
  somebody their upload.
- **Absent optionals cross the boundary as `null`, not `undefined`.** Pydantic
  serialises an unset `str | None` as JSON `null` and `undefined` has no JSON
  spelling, so any optional field in a schema both runtimes read must be
  `.nullish()` rather than `.optional()`. `packages/shared/test/contract.test.ts`
  holds literal `model_dump_json()` output to keep that honest.
- **Licensing discipline:** the default build must be cleanly Apache-2.0
  compatible. AGPL/commercially-restricted dependencies (PyMuPDF, Marker) live
  only behind the Compose `advanced` profile. Asserted by
  `services/worker/tests/test_licensing.py`, which audits the *installed*
  environment rather than the lockfile — a restrictively-licensed package
  almost always arrives as somebody else's transitive dependency, and that is
  visible at install time and not at resolve time. This is the constraint that
  chose the whole OCR stack: PyMuPDF and Marker are the strongest tools for the
  job and both are AGPL.

## Commands

Everything above `pnpm codegen` exists as of Phase 04; the rest are created by
Phase 08 and later. Implement them with exactly these names, because every later
phase assumes them.

Node 22.13+ and pnpm 11 are required; `uv` fetches its own Python 3.12.

```bash
pnpm install
pnpm turbo build lint typecheck test     # the standard gate
pnpm test:integration                    # Testcontainers: schema + auth; needs Docker
pnpm --filter @konusbitr/web dev
pnpm dev:infra                           # compose up backing services only, migrated (native hot reload)
pnpm dev                                 # infra + native web + native worker
pnpm infra:down                          # stop containers; infra:reset also drops volumes
pnpm infra:logs / infra:ps / infra:psql  # same set exists as `make` targets
pnpm codegen                             # Zod → pydantic; must be a no-op on a clean tree
./scripts/vendor-fixture-fonts.py        # re-subset the fixture fonts; rarely needed
pnpm db:migrate                          # idempotent; a `migrate` one-shot runs it on every compose up
pnpm infra:migrate                       # the same one-shot, without restarting the stack
pnpm --filter @konusbitr/db db:generate  # regenerate a migration after a schema edit
pnpm db:seed
pnpm eval:retrieval                      # recall@8, MRR, context precision; needs Docker
pnpm eval:retrieval -- --write           # re-record evals/RESULTS.md (never in CI)
pnpm eval:retrieval -- --broken-chunker  # must fail: proves the gate can
pnpm benchmark:retrieval                 # p95 over 100k chunks, ef_search sweep
pnpm eval:chat                           # Ragas + citation accuracy
```

Python side (`services/worker`): `uv sync` then `uv run pytest`. Use `uv` — not
pip or poetry.

Single test: `pnpm vitest run path/to/file.test.ts -t "name"` for TS,
`uv run pytest path/to/test.py::test_name` for Python.

Infra: `docker compose up` (default profile), `--profile local-llm` adds Ollama,
`--profile advanced` adds the restrictively-licensed extras.

## Conventions

- Package scope `@konusbitr/*`; Python package `konusbitr_worker`.
- TypeScript strict everywhere, plus `noUncheckedIndexedAccess` and
  `verbatimModuleSyntax`. Zod v4 for all boundary validation. Drizzle for all SQL.
- Conventional commits, enforced by a commitlint hook. Each phase is one or more
  PRs, never one giant commit. Changesets for versioning.
- Apache-2.0.
- Nothing merges without typecheck, lint, unit tests, **and** the phase's
  acceptance criteria.
- Performance budgets are acceptance criteria, not aspirations: 50-page text PDF
  parsed < 20s; 50-page scanned PDF < 2min on CPU OCR; retrieval p95 < 400ms on
  100k chunks; chat p95 TTFT < 1.5s. CI fails on regression.
- Eval gates: recall@8 dropping more than 2 points fails CI; faithfulness dropping
  more than 2 points fails CI.

## Design rules (from `design.md`)

Read `design.md` before writing any UI. It is a specification, not a mood board,
and several of its rules are absolute:

- **Instrument Serif** for headings/display; **LINE Seed JP** for all other UI text.
- **Sepia light is the default theme** — warm archival paper, never pure white.
  Tokens are defined in `design.md` §3.
- **Never use emoji in the product UI.** Use icons — simple, monoline, monochrome.
- **Hover must not animate anything.** No transform, scale, slide, fade, or
  rotation on hover; only the pointer cursor changes. Motion is reserved for
  purposeful transitions (menus, dialogs, sidebar, citation focus) at
  120/180/280ms, respecting `prefers-reduced-motion`.
- Minimal, document-first: avoid unnecessary cards, borders, shadows, gradients.
  Hierarchy comes from typography and whitespace.
- Never communicate state by color alone; accessibility is never traded for
  minimalism (keyboard navigation, focus rings, ARIA live regions for streaming,
  screen-reader labels on icon-only controls).
- Responsive down to 375px by simplifying, not by cramming the three-column
  desktop layout onto a phone.
