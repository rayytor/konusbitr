# Konusbitr

**Konusbitr** is an open-source, self-hostable alternative to PDF.ai. Upload
documents, chat with them, and get answers with **clickable, page-accurate
citations** — then drive the whole thing through a PDF.ai-wire-compatible `/v2`
REST API.

> **Status: early.** This repository is being built phase by phase (see
> [`phases/`](./phases)). Phase 01 lays the monorepo foundation; the product
> itself ships at Phase 11.

## Why two runtimes

TypeScript owns the product surface — the web app, the API, auth, billing —
because the streaming-chat-UI ecosystem lives there. Python owns the document
pipeline because every serious PDF layout and OCR library (Docling, PaddleOCR,
Surya) is Python.

The entire contract between them is a Redis queue plus JSON payloads: no shared
ORM, no RPC framework, no imports across the boundary. The Zod schemas in
`packages/shared` are the source of truth, and the worker's pydantic models are
generated from them.

## Layout

| Path | What lives there |
|---|---|
| `apps/web` | Next.js 15 App Router, React 19, Tailwind v4, shadcn/ui |
| `apps/extension` | WXT Chrome extension (Phase 15) |
| `services/worker` | Python 3.12, FastAPI + arq, package `konusbitr_worker` |
| `packages/shared` | Zod schemas and types — the cross-boundary source of truth |
| `packages/db` | Drizzle schema, migrations, scoped client (Phase 03) |
| `packages/sdk` | Generated TypeScript client (Phase 13) |
| `packages/tsconfig` | Shared strict TypeScript configuration |
| `docker/` | Dockerfiles and Compose fragments (Phase 02) |
| `docs/` | Docs site, ADRs, coordinate and licensing references |

## Quickstart

Requires **Node 22.13+**, **pnpm 11**, and **[uv](https://docs.astral.sh/uv/)**.
You do not need a system Python: `uv` fetches the 3.12 interpreter itself.

```bash
pnpm install
pnpm turbo build lint typecheck test
```

Run the web app:

```bash
pnpm --filter @konusbitr/web dev
```

`http://localhost:3000` serves the placeholder page and
`http://localhost:3000/api/health` returns `{ "ok": true, "version": "…" }`.

Run the Python worker's tests:

```bash
cd services/worker && uv sync && uv run pytest
```

A one-command `docker compose up` arrives with **Phase 02 — Local
Infrastructure**.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) first — especially the section on the
two-runtime boundary, which is the one architectural rule that is not negotiable.

## Licence

[Apache-2.0](./LICENSE). The default build is kept cleanly Apache-2.0
compatible; AGPL and commercially restricted dependencies live only behind the
optional Compose `advanced` profile.
