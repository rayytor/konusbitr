# Phase 02 — Local Infrastructure (`docker compose up`)

**Goal:** one command brings up every backing service Konusbitr needs, on any
machine, with no manual setup. This is a headline feature of the project, not
just developer convenience — self-hosters judge the project on it.

## Context

Konusbitr stores everything it can in **Postgres 17 + pgvector** (embeddings,
full-text search, JSONB parse artifacts) so operators have one database to back up.
Blobs go to **MinIO** (S3-compatible, so the same code works against S3/R2/B2).
**Redis** carries the job queue and rate-limit counters. **Ollama** is optional
and enables the fully-offline mode that PDF.ai cannot offer.

## Scope

### 1. `docker-compose.yml`

Services:

| Service | Image | Notes |
|---|---|---|
| `postgres` | `pgvector/pgvector:pg17` | Named volume, healthcheck `pg_isready` |
| `redis` | `redis:7-alpine` | AOF persistence on, healthcheck `redis-cli ping` |
| `minio` | `minio/minio` | Console on 9001, healthcheck on `/minio/health/live` |
| `minio-init` | `minio/mc` | One-shot: create the `konusbitr` bucket + a dev access key |
| `web` | built from `docker/web.Dockerfile` | Depends on postgres/redis/minio healthy |
| `worker` | built from `docker/worker.Dockerfile` | Python service (placeholder image until Phase 06) |
| `ollama` | `ollama/ollama` | **Profile `local-llm`**, not started by default |

Profiles:
- default — postgres, redis, minio, web, worker
- `local-llm` — adds ollama and pre-pulls a chat + embedding model
- `advanced` — reserved for AGPL/restrictively-licensed extras (PyMuPDF, Marker)
  added in Phase 12. Keep the default image free of them.

### 2. Configuration

A single `.env` at the repo root, documented in `.env.example`:

```
DATABASE_URL=postgres://konusbitr:konusbitr@postgres:5432/konusbitr
REDIS_URL=redis://redis:6379
S3_ENDPOINT=http://minio:9000
S3_BUCKET=konusbitr
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true
LLM_PROVIDER=openai            # openai|anthropic|google|mistral|ollama|vllm
LLM_API_KEY=
LLM_CHAT_MODEL=
EMBEDDING_MODEL=
BILLING_ENABLED=false
CREDITS_MODE=unlimited          # unlimited|metered
```

Validate env at process start with Zod (`packages/shared/env.ts`) and with
pydantic-settings on the Python side. **Fail loudly at boot on a missing or
malformed variable** — never lazily at first use.

### 3. Dockerfiles

- `docker/web.Dockerfile` — multi-stage, pnpm fetch → build → slim runtime,
  Next.js standalone output, non-root user.
- `docker/worker.Dockerfile` — `python:3.12-slim`, `uv sync --frozen`, non-root.

Both must build for `linux/amd64` and `linux/arm64`.

### 4. Postgres bootstrap

An init script enabling `vector`, `pg_trgm`, and `unaccent`. Do **not** create
tables here — migrations own the schema (Phase 03).

### 5. Developer ergonomics

- `pnpm dev:infra` — compose up only the backing services, so app and worker can
  run natively with hot reload.
- `pnpm dev` — infra + native web + native worker.
- A `Makefile` or `scripts/` wrapper with `up`, `down`, `reset` (down + volume prune),
  `logs`, `psql`.

## Acceptance criteria

- [ ] On a clean machine with Docker only: `cp .env.example .env && docker compose up`
      reaches all-healthy with no manual steps, and `http://localhost:3000/api/health`
      returns `{ ok: true }`.
- [ ] `docker compose --profile local-llm up` additionally serves Ollama on 11434.
- [ ] MinIO bucket `konusbitr` exists automatically after first boot.
- [ ] `SELECT extname FROM pg_extension` includes `vector`.
- [ ] Removing any required env var makes web and worker exit with a clear message
      naming the variable.
- [ ] `pnpm dev:infra` plus native processes works for hot-reload development.
- [ ] Both images build on amd64 and arm64 in CI.
