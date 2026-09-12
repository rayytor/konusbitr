# konusbitr-worker

The Python half of Konusbitr: fetch, validate, parse, OCR, chunk and embed
documents. FastAPI for health and control, a Redis-stream consumer for the job
loop.

**The parse itself is a stub until Phase 07.** Everything around it is real:
the job contract, the consumer group, the retry policy, the progress events the
browser reads over SSE, and the writes that make a redelivered job harmless.
`pipeline.py` sleeps where Docling will work, and Phase 07 replaces the body of
`run_parse` without touching the seam.

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
