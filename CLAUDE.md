# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state of this repository

**Phases 01–05 are done; Phase 06 is next.** `cp .env.example .env &&
docker compose up` brings up the whole backing stack, and the repo installs,
builds, lints, typechecks and tests on both runtimes. The database schema is
complete, every request into the app resolves to an authenticated principal
scoped to one organization, and documents can be uploaded (direct-to-storage
presigned PUTs), imported from URLs (with SSRF protection), listed, read, and
deleted. The docId cache is live: re-uploading the same file returns the same
document in milliseconds with zero cost and no job. What exists:

- `docker-compose.yml` + `docker/` — Postgres 17 with pgvector, Redis, MinIO
  (bucket and dev access key created automatically), a `migrate` one-shot that
  applies the migrations before web and worker start, the web image and the
  worker image, plus the `local-llm` profile for Ollama. `advanced` is declared
  and deliberately empty until Phase 12.
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
  hashing, and the docId cache resolver. `src/lib/upload-client.ts` is the
  browser-side uploader (XHR direct-to-storage, multipart above 16MiB,
  progress events). Standalone output for the container; env validated at boot
  from `src/instrumentation.ts`. No parsing or chat yet (Phase 06+).
- `packages/storage` — the S3-compatible object store client (AWS SDK v3).
  `presignPut`, `presignGet`, `head`, `delete`, `deletePrefix`, `streamGet`,
  `uploadStream`, `presignMultipart`, `completeMultipart`, `abortMultipart`.
  Key layout: `orgs/{orgId}/documents/{docId}/original.{ext}` — keys are
  derived from generated ids, never from user input. Unit and Testcontainers
  integration-tested against real MinIO.
- `packages/shared` — the Zod contracts (`Citation`, `DocumentStatus`,
  `ParseSettings`, `JobProgress`) plus `upload.ts` (intake request/response
  schemas, MIME allowlist, filename sanitization) and `env.ts`, the TypeScript
  half of the environment contract.
- `services/worker` — a Python 3.12 package under uv, pytest and ruff green.
  `settings.py` is the pydantic-settings half of the same contract; `__main__`
  validates it, heartbeats for the container healthcheck and idles. No FastAPI
  or arq yet (Phase 06).
- `packages/db` — the complete Drizzle schema (17 tables, auth included),
  migrations, the `scopedDb(orgId)` multi-tenancy helper with document CRUD
  queries (`listDocuments`, `documentById`, `documentByHashes`,
  `createDocument`, `deleteDocument`), `newId(prefix)`, the migration runner
  (`pnpm db:migrate`) and the seed script (`pnpm db:seed`).
  `packages/db/src/queries/documents.ts` has the unscoped
  `globalParseResultByHashes` for `ALLOW_GLOBAL_PARSE_CACHE`. Integration-tested
  with Testcontainers against real Postgres with pgvector.
- `packages/sdk`, `apps/extension`, `docs/` — placeholders whose
  READMEs name the phase that fills them in.

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

**The entire contract between them is a Redis queue plus JSON payloads** — no
shared ORM, no RPC framework, no imports across the boundary. Never add a
cross-language import or a shared database access layer; that seam is what keeps a
two-language codebase contributable.

The Zod schema in `packages/shared` is the source of truth for the job payload;
the pydantic model is **generated** from it via `pnpm codegen`, and CI fails on
drift. Contract drift is the main failure mode of this design.

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
  → enqueue parse job on konusbitr:jobs
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
  worker, not the viewer. Documented in `docs/coordinates.md`.
- **Citations are verified mechanically before they reach the client.** Every
  quote must actually appear in the parse result for the page it cites
  (exact match, then fuzzy for hyphenation/ligature noise). Unverifiable citations
  are dropped and logged; the rejection rate is a health metric. Target citation
  accuracy ≥ 98% (≥ 95% on scans).
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
- **All model calls go through the LiteLLM router.** Never import a provider SDK
  directly. Roles (`chat`, `embedding`, `rerank`, `vision`) are configured
  independently. `OFFLINE_MODE=true` must make any non-local endpoint raise
  immediately — it is a headline claim and is tested.
- **Prompts live in versioned files** under `packages/ai/prompts/`, never inline
  string literals, so an eval score change can be attributed to a prompt change.
- **Document text is untrusted data.** It never becomes instructions, never drives
  tool execution, and never reaches Sentry.
- **Ids are prefixed ULID-ish strings** (`doc_…`, `chk_…`, `org_…`, `key_…`) via a
  `newId(prefix)` helper. Storage keys are derived from generated ids, never from
  user input.
- **Fail loudly at boot** on missing/malformed env — Zod on the TS side,
  pydantic-settings on the Python side. Never lazily at first use.
- **No WebSockets anywhere.** Progress and streaming use SSE.
- **Licensing discipline:** the default build must be cleanly Apache-2.0
  compatible. AGPL/commercially-restricted dependencies (PyMuPDF, Marker) live
  only behind the Compose `advanced` profile, asserted by a CI license audit.

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
pnpm db:migrate                          # idempotent; a `migrate` one-shot runs it on every compose up
pnpm infra:migrate                       # the same one-shot, without restarting the stack
pnpm --filter @konusbitr/db db:generate  # regenerate a migration after a schema edit
pnpm db:seed
pnpm eval:retrieval                      # recall@8, MRR, context precision
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
