# Phase 15 — Distribution, Hardening, and Launch

**Goal:** turn a working application into an open-source project people can find,
trust, deploy, extend, and contribute to. Konusbitr is a complete PDF.ai
alternative at the end of this phase.

## Context

The code is done; adoption is not a marketing afterthought but the last
engineering problem. A self-hoster who cannot deploy in ten minutes, a developer
who cannot find the API docs, and a contributor who cannot run the test suite are
all lost users. This phase removes each of those failure modes, then ships.

## Scope

### 1. Chrome extension (`apps/extension`)

Manifest V3, built with **WXT** (Vite, TypeScript, HMR).

- Detects an open PDF, including Chrome's built-in viewer
  (`chrome-extension://.../pdfviewer`) and PDFs behind auth in the current tab.
- Grabs the bytes and uploads them to the user's Konusbitr instance — the base URL
  is **configurable**, cloud or self-hosted, because that choice is the point of
  the project.
- Opens a side-panel chat reusing the Phase 11 chat components.
- Auth via a stored API key entered once in the options page; never ask for a
  password in the extension.
- Requests the minimum permissions (`activeTab`, `sidePanel`, `storage`), with
  each one justified in the store listing.
- Publish to the Chrome Web Store; document the unpacked-install path for people
  who would rather not.

### 2. Deployment paths

- **Docker Compose** (already the default) — polished, with a `compose.prod.yml`
  including TLS via Caddy, backups, and resource limits.
- **Helm chart** for Kubernetes: separate app/worker deployments, HPA on queue
  depth, PVCs, secrets, and an ingress. Tested against kind in CI.
- **One-click templates** for Railway, Render, and Fly.io.
- **Managed-services recipe**: Vercel (app) + Fly.io (worker) + Neon (Postgres +
  pgvector) + Cloudflare R2 + a hosted model provider.
- An upgrade guide with a migration policy: migrations are forward-only and safe
  to run against a live database.

### 3. Documentation site (`docs/`)

Fumadocs or Mintlify, deployed on every merge:

- **Quickstart** — three commands to a cited answer.
- **Self-hosting** — configuration reference for every env var, sizing guidance,
  backups, upgrades, and troubleshooting.
- **Model guide** — cloud vs local, cost and quality tradeoffs, how to run fully
  offline, and how to pick an embedding model.
- **API reference** — generated from the Phase 13 OpenAPI spec, with runnable
  examples in curl, TypeScript, and Python.
- **Migrating from PDF.ai** — the endpoint compatibility table and the base-URL swap.
- **Architecture** — the two-runtime design, the queue contract, the citation
  pipeline, and the ADRs.
- **Contributing** — how to run each half alone, how to add a parser, how to add a
  model provider, and how to run the eval suite.

### 4. Observability and operations

- **OpenTelemetry** traces across web → queue → worker → model calls, exported to
  Grafana/Tempo; a shipped Grafana dashboard JSON.
- **Langfuse** for LLM traces, token cost, and prompt versioning.
- **Sentry** for errors, with PII scrubbing on by default (document text must never
  reach an error tracker).
- Health, readiness, and metrics endpoints; queue-depth and failed-job alerts.

### 5. Security hardening and review

- Full pass over the Phase 08 threat list: PDF and zip bombs, SSRF on every
  user-supplied URL including webhooks, per-org storage isolation, prompt
  injection, key handling, and dependency CVEs (Dependabot + `pnpm audit` +
  `pip-audit` in CI).
- Container images scanned with Trivy; run as non-root; minimal base images.
- A penetration-test checklist in `SECURITY.md` with a coordinated-disclosure
  policy and a contact address.
- Confirm the licence audit: default build clean of AGPL and non-commercial
  dependencies; `advanced` profile clearly labeled.

### 6. Quality gates at full strength

Everything from earlier phases, now enforced together on every PR:

- unit (Vitest + pytest), integration (Testcontainers), E2E (Playwright)
- retrieval + Ragas evals, with the **citation-accuracy ≥ 98%** gate and the
  **faithfulness regression > 2 points fails** rule
- k6 load thresholds: p95 TTFT < 1.5s, ingest throughput floor
- multi-arch image builds, Helm chart lint and kind install

### 7. Launch

- A landing page stating the wedge plainly: self-hostable, bring-your-own-model,
  fully offline capable, no page caps, PDF.ai-API-compatible.
- A demo instance with sample documents, a demo video of the citation click-through,
  and a comparison table against PDF.ai that is **honest about what Konusbitr does
  not yet do**.
- `v1.0.0` with changesets release notes, a public roadmap, good first issues, and
  a Discord or Discussions space.
- Launch posts to Hacker News, r/selfhosted, r/LocalLLaMA, and Product Hunt.

### 8. The post-1.0 roadmap (write it down, don't build it here)

DOCX/PPTX/EPUB/image ingest (cheap now that parsing is abstracted), page-level
annotations and notes, document comparison/diff mode, agentic multi-step research
over the corpus, an **MCP server** so Claude and Cursor can query a user's library,
and audit logs plus SSO for enterprise self-hosters.

## Acceptance criteria

- [ ] The extension chats with a PDF open in a browser tab against both a cloud and
      a self-hosted instance, and is submitted to the Chrome Web Store.
- [ ] The Helm chart installs on kind in CI and serves a working instance.
- [ ] Every one-click template deploys to a working instance from a clean account.
- [ ] The docs site is live, and its quickstart works verbatim on a clean machine.
- [ ] Traces span web → worker → model call in Grafana; Langfuse shows LLM cost.
- [ ] Sentry contains no document text under a deliberate error-injection test.
- [ ] Trivy reports no critical vulnerabilities in either image.
- [ ] The full CI gate — unit, integration, E2E, evals, load, license audit — is
      green and required for merge on `main`.
- [ ] `v1.0.0` is tagged with release notes, a roadmap, and good first issues.
- [ ] A new user can go from finding the repo to a cited answer on their own
      document, fully offline, in under ten minutes.
