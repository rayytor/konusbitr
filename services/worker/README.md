# konusbitr-worker

The Python half of Konusbitr: fetch, validate, parse, OCR, chunk and embed
documents. FastAPI for health and control, a Redis-stream consumer for the job
loop.

**The parse is real as of Phase 07** and handles born-digital PDFs. A document
is fetched from storage and re-hashed, opened with PDFium for structure and
text-layer coverage, converted by Docling, normalized into the Konusbitr parse
artifact, and written to `parse_results` and `pages` alongside one WebP
thumbnail per page. OCR, scanned documents and the VLM tier are Phase 12;
chunking and embedding are Phase 08.

## The parse pipeline

`parse/` is one module per stage, and the split is deliberate — `pipeline.py`
holds the orchestration and every write, so the rules that make an
at-least-once queue safe stay small enough to read in one sitting:

| module              | what it owns                                              |
| ------------------- | --------------------------------------------------------- |
| `storage.py`        | the S3 client: get the object down, put thumbnails back up |
| `inspect.py`        | PDFium: readable, not encrypted, page ceiling, text layer  |
| `docling_parser.py` | Docling, and the normalization of what it returns          |
| `geometry.py`       | the one coordinate convention, and every conversion into it |
| `thumbnails.py`     | one WebP per page, rendered from the rotated page          |
| `artifact.py`       | the shape everything downstream reads                       |

Two things are worth knowing before changing any of it.

**Coordinates.** PDF points, origin top-left, y downward, rotation already
applied. `docs/coordinates.md` is the specification and `geometry.py` is the
only place anything converts into it. If the Phase 11 viewer ever needs more
than a scale factor, the bug is here.

**A scan is refused, not parsed.** A standard-tier parse of an image-only PDF
succeeds and returns almost nothing, and a chat built on that answers
confidently out of an empty document. `inspect.py` measures extractable-character
coverage per page and fails the job with `needs_ocr` when more than a fifth of
the pages fall below `TEXT_COVERAGE_THRESHOLD`.

Docling's layout models are baked into the container image at build time
(`docker/worker.Dockerfile`), so no job ever waits on a model download and
`OFFLINE_MODE` stays honest. Running natively, Docling fetches them to its own
cache on first use.

### Fixtures and the slow suite

`fixtures/pdf/` at the repo root holds the committed corpus, all of it produced
by `fixtures/generate.py` — nothing scraped, nothing copyrighted, and every
expected string is one this repository wrote into the document. Regenerate with:

```bash
uv run --no-project --with reportlab --with pillow python ../../fixtures/generate.py
```

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
| `pipeline.py` | The work. A stub until Phase 07. |
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
