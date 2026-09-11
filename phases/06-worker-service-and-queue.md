# Phase 06 — Python Worker Service & the Job Contract

**Goal:** a running Python document-pipeline service that consumes jobs enqueued
by the TypeScript side, reports progress, and streams that progress back to the
browser. The pipeline itself is still a stub — this phase proves the seam.

## Context

Konusbitr deliberately runs two languages. The entire contract between them is
**a Redis queue plus JSON payloads** — no shared ORM, no RPC framework, no
imports across the boundary. That hard interface is what keeps a two-language
codebase contributable. Getting it right now means Phases 07, 08, and 12 are
ordinary Python work with no integration surprises.

## Scope

### 1. Service skeleton (`services/worker`)

FastAPI app + **arq** async Redis worker in one deployable:
- `GET /health` — liveness, reports queue connectivity and model availability.
- `GET /ready` — readiness, verifies Postgres, Redis, and S3 reachability.
- arq worker with configurable concurrency (`WORKER_CONCURRENCY`, default 2) and
  per-job timeout.
- pydantic-settings config validated at boot, mirroring the env from Phase 02.
- Structured JSON logging with `job_id`, `doc_id`, `org_id` on every line.

### 2. The job contract (`packages/shared` + a mirrored pydantic model)

Queue name `konusbitr:jobs`. Payload:

```json
{
  "jobId": "job_...",
  "type": "parse" | "chunk_embed" | "split" | "reindex",
  "orgId": "org_...",
  "documentId": "doc_...",
  "storageKey": "orgs/.../original.pdf",
  "contentHash": "sha256:...",
  "settings": { "quality": "standard", "langList": ["en"], "llm": false },
  "attempt": 1
}
```

**The Zod schema in `packages/shared` is the source of truth.** Generate the
pydantic model from it (JSON Schema → `datamodel-code-generator`) in a `pnpm
codegen` step, and fail CI if the generated file is out of date. A drifting
contract is the main failure mode of this architecture; make drift impossible to
merge.

BullMQ on the TS side and arq on the Python side must agree on the Redis key
format. If reconciling the two encodings costs more than a day, use a plain
Redis stream (`XADD`/`XREADGROUP`) with a consumer group as the transport and
drop both libraries' job wrappers — the simpler transport is the better default.
Decide this explicitly and write the decision into `docs/adr/0001-queue.md`.

### 3. Status, progress, and retries

- The worker writes progress to `jobs` (status, stage, percent) and publishes to
  a Redis pub/sub channel `konusbitr:progress:{documentId}`.
- Stages, in order: `queued → parsing → ocr → embedding → ready | failed`.
- Retries: 3 attempts with exponential backoff. Distinguish **retryable**
  (network, model timeout, OOM) from **terminal** (corrupt file, unsupported
  format) — terminal failures must not burn retries. Store the error message and
  a stable `error_code` on the document.
- Idempotency: a job re-delivered after a crash must not duplicate rows. Every
  write path is an upsert keyed on `(document_id, …)`.
- A dead-letter list plus `GET /api/admin/jobs/failed` for operators.

### 4. SSE progress to the browser

`GET /api/documents/:id/events` (Next.js Route Handler) subscribes to the Redis
channel and emits SSE frames `{ stage, percent, message }`, closing on `ready` or
`failed`. Must survive a reconnect by first replaying current state from the
`jobs` row, then subscribing. No WebSockets anywhere in Konusbitr.

### 5. Stub pipeline

For this phase the `parse` handler sleeps in stages, emits realistic progress,
writes a fake `parse_results` row with placeholder markdown, and marks the
document `ready`. Phase 07 replaces the body without touching the seam.

### 6. Tests

- pytest: contract round-trip (a fixture payload validates against the pydantic
  model), retry classification, idempotent re-delivery.
- An integration test that enqueues from TypeScript and asserts the Python worker
  processed it, run against Testcontainers Redis in CI.

## Acceptance criteria

- [ ] `docker compose up` starts the worker healthy; `/health` and `/ready` pass.
- [ ] Uploading a document from the app drives a document from `queued` to `ready`
      through the stub pipeline.
- [ ] The browser shows live progress over SSE, and a page refresh mid-job
      resumes showing correct progress.
- [ ] Killing the worker mid-job and restarting it completes the job exactly once.
- [ ] A payload that fails schema validation is dead-lettered, not retried forever.
- [ ] `pnpm codegen` is a no-op on a clean tree, and CI fails if the pydantic model
      drifts from the Zod schema.
- [ ] `docs/adr/0001-queue.md` records the chosen transport and why.
