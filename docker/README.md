# docker/

Everything `docker compose up` needs. The Compose file itself lives at the repo
root, because that is where a self-hoster looks for it; this directory holds the
images it builds and the scripts that bootstrap the backing services.

```
web.Dockerfile              Next.js, multi-stage, standalone output, non-root
worker.Dockerfile           Python 3.12 + uv, non-root
postgres/initdb/            extensions enabled on first boot
minio/init.sh               bucket + unprivileged access key
ollama/pull-models.sh       chat + embedding model for the local-llm profile
```

## The stack

| Service | Image | Purpose |
|---|---|---|
| `postgres` | `pgvector/pgvector:pg17` | Embeddings, full-text search, JSONB parse artifacts — one database to back up |
| `redis` | `redis:7-alpine` | Job queue, progress pub/sub, rate-limit counters. AOF on |
| `minio` | `minio/minio` | S3-compatible blob storage; console on 9001 |
| `minio-init` | `minio/mc` | One-shot: creates the bucket and a dev access key, then exits |
| `web` | `docker/web.Dockerfile` | The Next.js app on 3000 |
| `worker` | `docker/worker.Dockerfile` | The Python pipeline |
| `ollama` | `ollama/ollama` | Profile `local-llm` only; serves on 11434 |
| `ollama-init` | `ollama/ollama` | Profile `local-llm` only; pre-pulls the models |

### Profiles

- **default** — postgres, redis, minio, minio-init, web, worker.
- **`local-llm`** — adds Ollama and pulls a chat and an embedding model, which
  is what turns `OFFLINE_MODE=true` into a claim the project can stand behind.
- **`advanced`** — reserved for the AGPL / commercially-restricted parser extras
  (PyMuPDF, Marker) that Phase 12 adds. The default images must stay cleanly
  Apache-2.0 compatible and a CI licence audit asserts it, so nothing that pulls
  those in may be added to the services above.

## Two ways to run

**Everything in containers** — what a self-hoster does, and what CI tests:

```bash
cp .env.example .env
docker compose up
```

**Backing services in containers, app code native** — what a contributor does,
because hot reload and a debugger both want the process on the host:

```bash
pnpm dev:infra   # postgres, redis, minio
pnpm dev         # the same, plus native web and native worker
```

This split is why `.env` uses `localhost` hostnames while `docker-compose.yml`
overrides `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT` and `OLLAMA_BASE_URL` with
container hostnames for its own two services. Do not "fix" `.env.example` to
point at `postgres:5432`; that breaks native development, which is the more
common path.

## Configuration

One `.env` at the repo root, documented by `.env.example`, feeds both runtimes.
It is validated at process start — Zod in `packages/shared/src/env.ts`,
pydantic-settings in `konusbitr_worker.settings` — and a missing or malformed
value kills the process immediately, naming the variable. There is no lazy
validation and no silent default for anything that matters.

The credentials in `.env.example` are development defaults. They are safe only
because the stack is local; change every one before exposing Konusbitr to a
network.

## Notes on the images

Both build for `linux/amd64` and `linux/arm64`, and CI builds each on a native
runner for that architecture rather than under emulation.

`web.Dockerfile` uses `pnpm fetch` so the dependency layer is invalidated only by
a lockfile change, then ships Next.js standalone output: the runtime image has no
pnpm, no sources and no `node_modules` beyond what Next traced as reachable.
`outputFileTracingRoot` in `apps/web/next.config.ts` points at the monorepo root,
which is why the standalone tree is nested under `apps/web/`.

`worker.Dockerfile` installs strictly from `uv.lock` with `--no-editable`, so the
virtualenv it copies into the runtime stage is self-contained rather than
pointing back at a build directory that no longer exists.

Until Phase 06 the worker runs a placeholder loop: it validates its settings,
keeps a heartbeat for the healthcheck and idles. The image, the non-root user and
the environment contract are all real from now on; only the job loop is missing.

## Schema

Postgres init scripts enable `vector`, `pg_trgm` and `unaccent` and nothing
else. They **do not create tables** — migrations own the schema (Phase 03), so
that a fresh `docker compose up` and an upgrade of a running deployment converge
on the same structure.
