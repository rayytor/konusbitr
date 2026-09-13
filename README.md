# Konusbitr

**Konusbitr** is an open-source, self-hostable alternative to PDF.ai. Upload
documents, chat with them, and get answers with **clickable, page-accurate
citations** — then drive the whole thing through a PDF.ai-wire-compatible `/v2`
REST API.

> **Status: `v0.1.0` — the product works end to end.** Upload a PDF, ask a
> question, and every sentence of the answer carries the page it came from.
> Click a page reference and the viewer scrolls there and highlights the exact
> region on the page. Phases 12–15 add breadth (OCR, the public API, billing,
> distribution); see [`phases/`](./phases).

## Why two runtimes

TypeScript owns the product surface — the web app, the API, auth, billing —
because the streaming-chat-UI ecosystem lives there. Python owns the document
pipeline because every serious PDF layout and OCR library (Docling, PaddleOCR,
Surya) is Python.

The entire contract between them is a Redis stream plus JSON payloads: no
shared ORM, no RPC framework, no imports across the boundary. The Zod schemas
in `packages/shared` are the source of truth, and the worker's pydantic models
— along with the Redis key names themselves — are generated from them, with CI
failing on any drift. [`docs/adr/0001-queue.md`](docs/adr/0001-queue.md)
records why the transport is a plain stream rather than a job library.

## Layout

| Path | What lives there |
|---|---|
| `apps/web` | Next.js 15 App Router, React 19, Tailwind v4, the viewer and the chat UI |
| `apps/extension` | WXT Chrome extension (Phase 15) |
| `services/worker` | Python 3.12, FastAPI + a Redis-stream consumer, package `konusbitr_worker` |
| `packages/shared` | Zod schemas and types — the cross-boundary source of truth |
| `packages/db` | Drizzle schema, migrations, scoped client |
| `packages/ai` | Model router and versioned prompt files |
| `packages/retrieval` | Hybrid search, RRF fusion, rerank |
| `packages/storage` | S3-compatible object store client |
| `evals/` | The golden set, the retrieval and chat harnesses, recorded results |
| `packages/sdk` | Generated TypeScript client (Phase 13) |
| `packages/tsconfig` | Shared strict TypeScript configuration |
| `docker/` | Dockerfiles and the scripts that bootstrap the stack |
| `docs/` | Docs site, ADRs, coordinate and licensing references |

## Quickstart

### Self-hosting: one command

Docker is the only prerequisite.

```bash
cp .env.example .env
docker compose up
```

That brings up Postgres with pgvector, Redis, MinIO, the web app and the worker,
creates the storage bucket, enables the database extensions and applies the
database migrations, with no manual steps. `http://localhost:3000/api/health`
then returns `{ "ok": true, "version": "…" }`, the worker answers on
`http://localhost:8081/health` and `/ready`, and the MinIO console is on
`http://localhost:9001`.

Add `--profile local-llm` for Ollama on `:11434` with a chat and an embedding
model pre-pulled — the fully-offline mode that a hosted service cannot offer.

The credentials in `.env.example` are development defaults. Change every one of
them before exposing Konusbitr to a network — `AUTH_SECRET` in particular, which
the app refuses to start with as soon as `APP_URL` stops being localhost.

### From zero to a cited answer

With the stack up:

1. Create an account at `http://localhost:3000/signup`.
2. `SMTP_URL` is unset by default, so the verification link is printed to the
   web server's log instead of emailed. Find it with
   `docker compose logs web | grep -A3 "Verify your Konusbitr email"` and open
   it.
3. You land in the library. Drop a PDF on the upload strip — or use
   `fixtures/pdf/text-50p.pdf` from this repository. The status badge walks from
   *Queued* to *Ready* over a live stream; nothing needs reloading.
4. Open it. The document is on the left and the chat is on the right; drag the
   divider, or press `⌘K` for everything the workspace can do.
5. Ask a question. The answer streams, and each claim ends in a page reference
   like `p. 42`. **Click it.** The viewer scrolls to that page and highlights
   the exact passage the claim came from.

Step 5 is the product. Every citation is checked against the text of the page it
names before it reaches the browser, and any that cannot be verified is dropped
rather than shown.

**No API key is required for steps 1 to 4.** Step 5 needs a chat model. The
fastest way to one that costs nothing and sends nothing anywhere:

```bash
docker compose --profile local-llm up
```

That adds Ollama with a chat and an embedding model pre-pulled. Set
`OFFLINE_MODE=true` in `.env` and Konusbitr will refuse to start if any role is
still pointed at a cloud provider — the offline claim is enforced at boot and
again at every call, not documented and hoped for.

Alternatively, name a hosted model:

```bash
LLM_PROVIDER=openai
LLM_API_KEY=sk-…
LLM_CHAT_MODEL=gpt-4o-mini
EMBEDDING_MODEL=openai/text-embedding-3-large
```

With no embedding model configured — the default — passages are stored without
vectors and retrieval is keyword-only. That is a supported state, not a broken
one; `POST /api/documents/:id/reindex` fills the vectors in once a model is
named.

### Signing in

Create an account at `http://localhost:3000/signup` — the schema is already
there, because a one-shot `migrate` container applies the migrations before the
web app starts and again on every `up`.

Email and password and magic links both work with no further configuration;
Google and GitHub appear on the login page only when you set their client id and
secret.

Mail is optional. With `SMTP_URL` unset, verification and magic-link messages
are written to the web server's log with their links intact, so
`docker compose logs web` is where you confirm your first account.

### Developing: backing services in Docker, code on the host

Requires **Node 22.13+**, **pnpm 11**, **[uv](https://docs.astral.sh/uv/)** and
Docker. You do not need a system Python: `uv` fetches the 3.12 interpreter
itself.

```bash
pnpm install
pnpm dev:infra          # postgres, redis and minio in containers, migrated
pnpm dev                # the same, plus native web and native worker
```

Running the app natively is what makes hot reload instant and lets a debugger
attach normally. This is why `.env` points at `localhost`: `docker-compose.yml`
substitutes container hostnames for its own two services.

Both apply pending migrations first, so the schema a native `pnpm dev` talks to
is the schema `docker compose up` would have produced. After editing the Drizzle
schema, `pnpm --filter @konusbitr/db db:generate` writes the migration and
`pnpm infra:migrate` applies it without restarting anything.

The standard gate, which is also what CI runs:

```bash
pnpm turbo build lint typecheck test
cd services/worker && uv sync && uv run pytest
```

The end-to-end suite drives a real browser against a production build, a real
Postgres, a real MinIO and the real worker. Only the chat model is substituted,
by a stub that quotes the first retrieved passage back verbatim — so the
citation the test clicks is deterministic while retrieval, verification, the
parse geometry and the viewer are all the real thing:

```bash
pnpm dev:infra && pnpm dev:worker   # in one terminal
pnpm test:e2e                        # in another
```

The assertion that matters is in `apps/web/e2e/citation.spec.ts`: after clicking
a citation, the highlight rectangle must land within two pixels of where the
stored bounding box says it belongs. A viewer that draws highlights in roughly
the right place looks fine in a screenshot and means the coordinate convention
has drifted.

`make help` lists the container shortcuts (`up`, `migrate`, `down`, `reset`,
`logs`, `psql`); each one also exists as a `pnpm infra:*` script.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) first — especially the section on the
two-runtime boundary, which is the one architectural rule that is not negotiable.

## Licence

[Apache-2.0](./LICENSE). The default build is kept cleanly Apache-2.0
compatible; AGPL and commercially restricted dependencies live only behind the
optional Compose `advanced` profile.
