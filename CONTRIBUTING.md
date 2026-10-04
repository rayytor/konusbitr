# Contributing to Konusbitr

Thanks for helping. This document covers the things that are easy to get wrong
in this repository; everything else is ordinary open-source practice.

## The one rule: the two-runtime boundary

Konusbitr has two runtimes on purpose.

- **TypeScript** owns the product surface: web app, API, auth, billing.
- **Python** owns the document pipeline: parse, OCR, chunk, embed.

**The entire contract between them is a Redis stream plus JSON payloads.** There
is no shared ORM, no RPC framework, and no import that crosses the language
boundary in either direction. The TypeScript side does not call into Python.

Both runtimes do use the same Postgres, and that is not a breach of the rule.
The worker reads and writes the database with raw SQL it owns, all of it in
`services/worker/src/konusbitr_worker/db.py`. Drizzle owns the *tables*: the
schema and every migration live in `packages/db`, and nothing in the worker
imports from it. So a schema change is made in Drizzle, and if it touches a
column the worker reads, `db.py` changes in the same pull request.

That seam is what keeps a two-language codebase contributable — you can work on
one half without understanding the other. A pull request that adds a
cross-language import or a shared database access layer will be rejected on
principle, however convenient it looks.

The job payload's source of truth is the Zod schema in `packages/shared`. The
pydantic models and the Redis key names are **generated** from it by
`pnpm codegen`; CI fails on drift. Contract drift is the main failure mode of
this design, so if you change a payload, change the Zod and regenerate — never
hand-edit `konusbitr_worker/contracts.py`.

## Running each side alone

You rarely need both halves running.

**TypeScript only** — everything in `apps/` and `packages/`:

```bash
pnpm install
pnpm --filter @konusbitr/web dev          # web app on :3000
pnpm turbo lint typecheck test            # the gate for this half
```

**Python only** — everything in `services/worker`:

```bash
cd services/worker
uv sync                                    # fetches Python 3.12 too
uv run pytest
uv run ruff check .
```

Use `uv`, not pip or poetry. The lockfile is `uv.lock` and CI installs from it.

**Both, with backing services** — Postgres, Redis and MinIO in containers,
application code native:

```bash
cp .env.example .env
pnpm dev:infra                             # backing services only
pnpm dev                                   # plus native web and native worker
```

`pnpm infra:down` stops the containers and `pnpm infra:reset` also deletes the
volumes. `make help` lists the same shortcuts for people who reach for `make`.

`.env` deliberately points at `localhost`, because that is what a natively-run
process needs; `docker-compose.yml` overrides those hostnames for its own
containers. Do not change `.env.example` to use container hostnames.

## Working on a phase

The work in this repository is organised as 15 phases under [`phases/`](./phases).
Each file is self-contained and ends with an acceptance-criteria checklist. The
status line at the top of the [README](./README.md) says which are done and
which is next; it is the one place that is stated, so a pull request that
finishes a phase updates it there.

- Read the phase file first and treat its checklist as the definition of done.
- Respect the non-goals section. Do not pull a later phase's scope forward.
- A phase is one or more pull requests, never one giant commit. `main` is
  protected: everything lands through a pull request.

## Standards

- **TypeScript is strict everywhere**, plus `noUncheckedIndexedAccess` and
  `verbatimModuleSyntax`. Zod v4 for all boundary validation. Drizzle for all SQL.
- **Lint and format with Biome** (`pnpm check:fix`). Python uses Ruff.
- **Conventional commits**, enforced by a commitlint hook. Scope is one of the
  packages, e.g. `feat(worker): normalize Docling bboxes`.
- **Changesets** for anything user-visible: `pnpm changeset`. See *Releasing*
  below for what happens to them.
- Nothing merges without typecheck, lint, unit tests, **and** the phase's
  acceptance criteria.
- Performance budgets are acceptance criteria, not aspirations. CI fails on
  regression.

## Releasing

A version is only real when four things agree: the package versions, the
changelogs, the OpenAPI document and a git tag. The steps, in a pull request of
their own:

```bash
pnpm version-packages      # consumes .changeset/*.md, bumps versions, writes CHANGELOG.md
pnpm codegen               # the OpenAPI document and both SDKs embed the version
cd services/worker && uv lock
```

- `@konusbitr/web` carries the product's version. `/api/health`, the landing
  page and `docs/openapi.json` all read it, so it is what the tag names.
- Two versions are not managed by changesets and are set by hand to match it:
  the root `package.json`, and the worker's `pyproject.toml` together with
  `konusbitr_worker.__version__`.
- Every workspace package is private except the SDK, and changesets skips
  private packages unless `.changeset/config.json` sets `privatePackages.version`.
  It is set. Without it `changeset version` reports success and changes nothing.
- After the pull request merges, tag the merge commit `v<version>` and push the
  tag. The SDKs are released separately by the tag `sdk-v<version>`, which runs
  `.github/workflows/release-sdks.yml`.

## Design changes

`design.md` is a specification, not a mood board. Read it before writing UI.
Several of its rules are absolute — Instrument Serif for display and LINE Seed
JP for UI text, sepia light as the default theme, no emoji in the product UI,
and **no hover animations of any kind**. If you believe one of those rules is
wrong, open an issue and change the specification first.

## Licence

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE).

The default build must stay cleanly Apache-2.0 compatible. AGPL or commercially
restricted dependencies — PyMuPDF, Surya — may only be added behind the Compose
`advanced` profile, and a CI licence audit asserts this. [`docs/licensing.md`](docs/licensing.md)
accounts for every package on both sides of that line.
