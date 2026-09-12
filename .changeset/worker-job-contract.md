---
'@konusbitr/shared': minor
'@konusbitr/db': minor
---

Add the cross-runtime job contract. `JobPayloadSchema`, `JobProgressSchema`,
the stage and error-code vocabularies and the Redis key names in
`packages/shared` are the single source of truth for everything that crosses
the TypeScript ↔ Python seam; `pnpm codegen` generates the worker's pydantic
models and key constants from them, and CI fails on any drift.

Optional fields that both runtimes read are `.nullish()` rather than
`.optional()`, because pydantic serialises an unset optional as JSON `null`
and `undefined` has no JSON spelling — a schema that accepted only `undefined`
silently rejected every event the worker published.

`@konusbitr/db` gains `documents.error_code` and `jobs.error_code` /
`jobs.attempts`, plus the `latestJobForDocument` and `listFailedJobs` scoped
queries the SSE and operator endpoints read.
