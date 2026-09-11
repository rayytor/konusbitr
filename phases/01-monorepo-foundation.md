# Phase 01 — Monorepo Foundation

**Goal:** a repository skeleton that builds, lints, typechecks, and runs CI on an
empty but well-shaped codebase. No product features. Everything after this phase
assumes these paths, names, and scripts exist.

## Context

Konusbitr is an open-source, self-hostable alternative to PDF.ai. It has two
runtimes on purpose: **TypeScript** owns the product surface (web app, API, auth,
billing) because the streaming-chat-UI ecosystem lives there; **Python** owns the
document pipeline because every serious PDF layout/OCR library (Docling, PaddleOCR,
Surya, PyMuPDF) is Python. This phase lays out both.

## Scope

### 1. Repo layout

```
konusbitr/
├── apps/
│   ├── web/                 # Next.js 15, App Router, React 19
│   └── extension/           # WXT Chrome extension (empty placeholder until Phase 15)
├── services/
│   └── worker/              # Python 3.12 FastAPI + arq (placeholder until Phase 06)
├── packages/
│   ├── db/                  # Drizzle schema, migrations, client
│   ├── shared/              # Zod schemas + types shared by web, API, SDK
│   └── sdk/                 # Generated TS client (placeholder until Phase 13)
├── docs/                    # Docs site source (placeholder until Phase 15)
├── docker/                  # Dockerfiles + compose fragments
├── .github/workflows/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

### 2. Tooling

- **pnpm workspaces + Turborepo.** Pin pnpm via `packageManager`. Turbo tasks:
  `build`, `dev`, `lint`, `typecheck`, `test`, `test:integration`.
- **TypeScript strict** everywhere. A shared `packages/tsconfig` base with
  `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.
- **Biome** (or ESLint + Prettier — pick one and commit to it) for lint/format.
- **Vitest** for TS unit tests; `pytest` configured in `services/worker`.
- **uv** for the Python service (`pyproject.toml`, locked). Python 3.12.
- **Changesets** for versioning and release notes.
- **Conventional commits** enforced by a commitlint hook via `lefthook` or `husky`.

### 3. `apps/web` bootstrap

Next.js 15 App Router, React 19, TypeScript strict, Tailwind CSS v4,
shadcn/ui initialized (Radix primitives, `components.json`, `cn` helper).
One placeholder route `/` rendering "Konusbitr" and one health route
`GET /api/health` returning `{ ok: true, version }`. No auth, no DB yet.

### 4. `packages/shared`

Zod v4 is the single source of truth for cross-boundary types. Seed it with the
contracts later phases will fill in — define them now so imports don't churn:

- `Citation` — `{ quote, page, bbox: [x0,y0,x1,y1], chunkId, schemaPath? }`
- `DocumentStatus` — `queued | parsing | ocr | embedding | ready | failed`
- `ParseSettings` — `{ quality: "standard" | "advanced", langList: string[], llm: boolean }`
- `JobProgress` — `{ jobId, stage, percent, message? }`

Export both the schemas and their inferred types.

### 5. CI skeleton

`.github/workflows/ci.yml` running on PR and push to `main`:
install (cached pnpm store + uv cache) → `turbo lint typecheck test build` →
`uv run pytest` in `services/worker`. Must be green on an empty repo.

### 6. Project hygiene

`README.md` (what Konusbitr is, quickstart placeholder), `LICENSE` (Apache-2.0),
`CONTRIBUTING.md` (the two-runtime boundary, how to run each side alone),
`SECURITY.md`, `CODE_OF_CONDUCT.md`, `.env.example`, `.gitignore`, `.editorconfig`.

## Non-goals

No database, no auth, no Docker Compose (Phase 02), no parsing, no UI beyond a
placeholder page.

## Acceptance criteria

- [ ] `pnpm install && pnpm turbo build lint typecheck test` passes from a clean clone.
- [ ] `pnpm --filter @konusbitr/web dev` serves `/` and `/api/health`.
- [ ] `cd services/worker && uv sync && uv run pytest` passes (zero or trivial tests).
- [ ] CI is green on a pull request.
- [ ] `packages/shared` exports the four seed schemas and is importable from `apps/web`.
- [ ] `LICENSE` is Apache-2.0 and `README.md` names the project Konusbitr.
