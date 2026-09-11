# Contributing to Konusbitr

Thanks for helping. This document covers the things that are easy to get wrong
in this repository; everything else is ordinary open-source practice.

## The one rule: the two-runtime boundary

Konusbitr has two runtimes on purpose.

- **TypeScript** owns the product surface: web app, API, auth, billing.
- **Python** owns the document pipeline: parse, OCR, chunk, embed.

**The entire contract between them is a Redis queue plus JSON payloads.** There
is no shared ORM, no RPC framework, and no import that crosses the language
boundary in either direction. The Python worker does not read the application
database; the TypeScript side does not call into Python.

That seam is what keeps a two-language codebase contributable — you can work on
one half without understanding the other. A pull request that adds a
cross-language import or a shared database access layer will be rejected on
principle, however convenient it looks.

The job payload's source of truth is the Zod schema in `packages/shared`. The
pydantic model is **generated** from it; CI fails on drift. Contract drift is
the main failure mode of this design, so if you change a payload, change the Zod
and regenerate — never hand-edit the Python side.

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

**Both, with backing services** — `pnpm dev:infra` and `pnpm dev` arrive with
Phase 02.

## Working on a phase

The work in this repository is organised as 15 phases under [`phases/`](./phases).
Each file is self-contained and ends with an acceptance-criteria checklist.

- Read the phase file first and treat its checklist as the definition of done.
- Respect the non-goals section. Do not pull a later phase's scope forward.
- A phase is one or more pull requests, never one giant commit.

## Standards

- **TypeScript is strict everywhere**, plus `noUncheckedIndexedAccess` and
  `verbatimModuleSyntax`. Zod v4 for all boundary validation. Drizzle for all SQL.
- **Lint and format with Biome** (`pnpm check:fix`). Python uses Ruff.
- **Conventional commits**, enforced by a commitlint hook. Scope is one of the
  packages, e.g. `feat(worker): normalize Docling bboxes`.
- **Changesets** for anything user-visible: `pnpm changeset`.
- Nothing merges without typecheck, lint, unit tests, **and** the phase's
  acceptance criteria.
- Performance budgets are acceptance criteria, not aspirations. CI fails on
  regression.

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
restricted dependencies — PyMuPDF, Marker — may only be added behind the Compose
`advanced` profile, and a CI licence audit asserts this.
