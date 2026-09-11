# konusbitr-worker

The Python half of Konusbitr: fetch, validate, parse, OCR, chunk and embed
documents. FastAPI for health and control, arq for the job loop.

The job loop itself is a placeholder until **Phase 06 — Worker Service and
Queue**. What is real today is the shape around it: `settings.py` validates the
environment at boot and dies naming the offending variable, `__main__` keeps a
heartbeat that the container healthcheck reads and exits cleanly on SIGTERM, and
`docker/worker.Dockerfile` builds a non-root image for amd64 and arm64.

## Running it alone

```bash
uv sync
uv run pytest
uv run python -m konusbitr_worker    # needs a .env; see .env.example
```

`uv` manages the interpreter as well as the dependencies, so you do not need a
system Python 3.12 — `uv sync` will fetch one. Do not use pip or poetry here;
the lockfile is `uv.lock` and CI installs from it.

## The boundary

This service never imports TypeScript code, never reaches into the application
database, and never shares an ORM with the web app. It receives JSON job
payloads over Redis and publishes JSON progress events back. The pydantic models
for those payloads are **generated** from the Zod schemas in
`packages/shared` — edit the Zod, run `pnpm codegen`, never hand-edit the
generated models.

Document text handled here is untrusted data: it never becomes instructions, it
never drives tool execution, and it never reaches error reporting.

## Configuration

`settings.py` is the pydantic-settings half of the environment contract; the Zod
half is `packages/shared/src/env.ts`, and `.env.example` at the repo root
documents both. It is hand-written on purpose — it is configuration rather than
a wire format, and it has to import before any code generation has run. The
generated payload models arrive in Phase 06 and are the things you must never
hand-edit.

Both halves fail loudly at boot rather than lazily at first use, and their tests
mirror each other so the two runtimes cannot quietly disagree about what `.env`
means.
