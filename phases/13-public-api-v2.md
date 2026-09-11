# Phase 13 — The Public API Platform (`/v2`, PDF.ai-compatible)

**Goal:** the half of Konusbitr that makes it useful to developers — `parse`,
`extract`, `split`, and `ask`, wire-compatible with `api.pdf.ai/v2`, so an
existing integration can be repointed by changing a base URL.

## Context

An open-source alternative that only ships a web app is a toy. PDF.ai's developer
platform is what gives it reach, and compatibility is the cheapest possible
migration story for the people most likely to adopt Konusbitr. Where we can
improve without breaking compatibility — chiefly by making every long-running
operation available asynchronously — we do.

## Scope

### 1. Surface

Mount **Hono** at `/v2/*` (faster, cleaner OpenAPI generation, and separable into
its own deployment later). All endpoints authenticate with `X-API-Key` and the
`AuthContext` from Phase 04.

```
POST /v2/parse     { file|url|docId, quality?, lang_list?, llm? }
                   → { docId, markdown, contents[], images[], pageCount }
POST /v2/extract   { file|url|docId, schema, system_prompt?, quality?, lang_list? }
                   → { docId, result, citations[] }
POST /v2/split     { file|url|docId, ranges? | mode: "semantic" }
                   → { documents: [{ docId, name, pages }] }
POST /v2/ask       { file|url|docId, question, language? }
                   → { answer, citations[] }

GET  /v2/documents/:docId      DELETE /v2/documents/:docId
GET  /v2/jobs/:jobId

POST /v1/chat-with-pdf         (legacy-compatible)
POST /v1/chat-with-all-pdfs    (legacy-compatible)
```

`file`, `url`, and `docId` are **mutually exclusive** — reject requests supplying
more than one. `docId` input skips straight to the cached parse: zero work, zero
credits.

### 2. Async twin

Every long-running endpoint accepts `?async=true`, returning `{ jobId }`
immediately, with an optional `webhook_url` called on completion. This is a
genuine improvement over the upstream synchronous-only design.

Webhooks: HMAC-SHA256 signature header, timestamp, retries with backoff, and an
SSRF guard on the callback URL identical to Phase 05's.

### 3. `extract` — the hard one

1. Validate the user's JSON Schema (depth, size, and field-count limits).
2. **Decompose**: for each top-level field, retrieve chunks relevant to that
   field's name and description. For documents under 30 pages, feed the whole
   markdown instead — simpler and better.
3. Constrained generation against the schema, requiring for every leaf value a
   verbatim `quote`, a `page`, and its `schema_path` (e.g. `result.people[2].name`).
4. **Verify** every quote against the parse result, exactly as in Phase 10. Drop or
   flag unverifiable values rather than returning them silently.
5. Return `{ docId, result, citations[] }`.

### 4. `split`

Page-range splitting via `pypdf` (PyMuPDF only under the `advanced` profile), plus
**semantic mode** that cuts at the Docling section tree's chapter/section
boundaries and names each output after its heading. Outputs are real documents
with their own `docId`s, inheriting the parent's parse where possible.

### 5. Credits and rate limits

- `credit_ledger` accounting: parse cost ∝ pages; extract 2×pages for schemas of
  ≤5 fields, 4×pages above; `docId` reuse free. Every charge is a ledger row with
  a reason and a reference — auditable, never a mutated balance.
- `CREDITS_MODE=unlimited` is the **self-host default**: usage is still recorded so
  operators get cost visibility, but nothing is ever refused for lack of credits.
  `metered` enforces balances for anyone running Konusbitr as a service.
- Redis token-bucket rate limits per key and per org, with
  `X-RateLimit-*` and `Retry-After` headers.
- Optional Stripe module, **disabled by default**, entirely removable.

### 6. Errors, spec, and SDKs

- One error envelope everywhere: `{ error: { code, message, details?, requestId } }`,
  with documented, stable codes and correct HTTP statuses.
- **OpenAPI 3.1 generated from the Zod schemas** — never hand-written, so it cannot
  drift. Served at `/v2/openapi.json` with a Scalar/Stoplight UI at `/v2/docs`.
- Generated SDKs from the spec: `packages/sdk` (TypeScript, published to npm) and
  `sdks/python` (published to PyPI). Both with retries, async support, typed
  errors, and a quickstart in their READMEs.

### 7. Tests

- Contract tests per endpoint including every documented error case.
- A compatibility test suite asserting responses match the documented PDF.ai
  shapes field-for-field.
- Credit arithmetic unit tests (the accounting must be exactly right).
- k6 load tests: `/v2/parse` throughput and chat streaming p95 TTFT.

## Acceptance criteria

- [ ] All four `/v2` endpoints plus both `/v1` legacy endpoints work against real
      fixtures and match the documented response shapes.
- [ ] Passing two of `file`/`url`/`docId` returns a 400 naming the conflict.
- [ ] A second `parse` with the same bytes and settings returns instantly with zero
      credits charged, and the ledger records a `cache_hit`.
- [ ] `extract` against a 10-field schema returns values whose citations all verify.
- [ ] `split mode: "semantic"` produces documents named after real section headings.
- [ ] `?async=true` returns a `jobId`, and the webhook fires with a valid HMAC signature.
- [ ] Exceeding the rate limit returns 429 with `Retry-After`.
- [ ] `/v2/openapi.json` validates as OpenAPI 3.1; CI fails if it drifts from the code.
- [ ] Both SDKs install from a registry and run their quickstart against a local instance.
- [ ] With `CREDITS_MODE=unlimited`, usage is recorded and nothing is ever refused.
