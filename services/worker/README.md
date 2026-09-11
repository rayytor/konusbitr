# konusbitr-worker

The Python half of Konusbitr: fetch, validate, parse, OCR, chunk and embed
documents. FastAPI for health and control, arq for the job loop.

Placeholder until **Phase 06 — Worker Service and Queue**.

## Running it alone

```bash
uv sync
uv run pytest
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
