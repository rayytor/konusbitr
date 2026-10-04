# 0009 — The public API: one route table, an in-process async twin, a ledger

**Status:** accepted (Phase 13)
**Supersedes nothing.** Extends `0001-queue.md` (the `split` job type) and
`0002-model-router.md` (`ask` and `extract` go through the same router).

## Context

Phase 13 is the half of Konusbitr a developer uses: `parse`, `extract`, `split`
and `ask` under `/v2`, wire-compatible with `api.pdf.ai/v2`, plus the two legacy
`/v1` chat endpoints. Three things had to be true of it that are not true of an
ordinary set of route handlers. The specification must not be able to drift from
the code. Every long-running call must be available asynchronously, which
upstream is not. And every credit spent — or not spent — must be explainable
from the database a month later.

## Decision

### The route table is the only description of the API

A route is declared once, in `apps/web/src/lib/v2/registry.ts`: its path, its
Zod request and response schemas, its scopes, its error codes, whether it has an
async twin. `mount.ts` turns that declaration into a Hono handler that validates
with those schemas; `openapi.ts` turns the same declaration into OpenAPI 3.1.
`docs/openapi.json` is that document, committed; both SDKs' types and operation
tables are generated from it.

`pnpm codegen` runs the whole chain — Zod → OpenAPI → TypeScript SDK → Python
SDK — and CI runs it and then `git diff --exit-code`. So an endpoint cannot be
implemented without being documented, documented without being implemented, or
changed without both clients changing with it.

Hono rather than more Next.js route handlers, and not for speed: `/v2` has its
own authentication chain, its own error envelope and its own rate limits, and an
app object can be lifted into its own deployment where twenty files under
`src/app/api` cannot. Handlers receive a plain `RouteContext`, never Hono's, so
no handler can check a scope, set a status or build an error body. They cannot
forget to, because they are not the ones doing it.

### The async twin runs in the web process

`?async=true` writes an `api_jobs` row, returns its id, and runs the same
handler detached. There is no second Node worker: the Python pipeline is the
worker, and an `extract` or an `ask` is not something it can be handed. What is
durable is the *row* — the result, or the same error envelope the synchronous
call would have returned. A live runner touches its row once a minute, and a
row that has gone thirty minutes without that heartbeat is reported as `failed`
when it is read, rather than left `running` forever. The heartbeat is what lets
an operation wait an hour on a long parse without being mistaken for a dead one.

That is a real limit and it is accepted knowingly. An operation in flight when
the web process restarts is lost and reported as failed; the document work
behind it is not, because that part is a queue job and the docId cache makes
the retry cheap. Moving `ask` and `extract` behind the Redis stream is the
revisit, and the trigger is the first deployment that restarts often enough to
notice.

Webhooks are signed `HMAC-SHA256` over `{timestamp}.{body}`, retried with
backoff, and the callback URL goes through the same SSRF guard as a URL import —
checked when the request is accepted, so a bad one is a 400 to the caller
rather than a job that fails later with nobody watching.

### `split` decides in TypeScript and cuts in Python

The decision — which pages, called what — needs the request body and the parse
artifact's section tree, both of which live on the TypeScript side. The cut
needs to open a PDF and write another, which only Python can do. So the queue
payload carries a list of ranges and the worker never sees a request.

Each output inherits its parent's parse: the elements for its pages, renumbered
from one. A split that re-parsed would charge a document's full cost once per
output and produce, at best, the same elements. Thumbnails and figures are
dropped from the inherited artifact because their objects live under the
*parent's* storage prefix and would dangle when it is deleted.

The worker creates the output's `documents` row, which is the one place it
creates one. The row needs a content hash, the hash is of bytes that do not
exist until the cut, and the column is `NOT NULL` under the docId cache's unique
index — a row written earlier would carry a placeholder, and the cache's
correctness cannot survive a "temporarily wrong" hash. `pypdf`'s output for the
same pages is byte-identical between runs, which a test pins, because that is
what makes a re-delivered split find its outputs rather than duplicate them.

### `extract` nulls what it cannot prove

Every leaf value must come with a verbatim quote, a page and its schema path,
and the quote is checked against the parse before the response is built. A value
whose quote is not in the document is returned as `null` and listed in
`unverified` with the reason. In chat an unverifiable citation is dropped and
the sentence survives; here the citation is the only evidence for the value, so
the value goes with it.

A quote containing digits must match exactly. The fuzzy window that forgives
hyphenation in prose scores `£1,234,567` against `£1,284,567` at 0.9, and in an
extraction that value *is* the number.

### Credits are a ledger, and the balance is its sum

Every charge is a row with a reason and a reference; there is no balance column
to mutate. `CREDITS_MODE=unlimited`, the self-host default, records usage and
refuses nothing. `metered` checks the balance before the work and charges after
it, so a failed operation is never billed; the worst case of that gap is one
operation's overdraft, which refuses the next call.

Two rows must exist exactly once however often they are attempted, and both go
through `recordCreditOnce`, which serializes per organization on an advisory
lock:

- **The starting grant.** `STARTING_CREDITS` is granted at an organization's
  first metered call, not at its creation, because an operator who switches
  from `unlimited` to `metered` has organizations that predate anything to
  grant. Granted at creation, each of them would start at whatever it had
  already used, negated.
- **A payment.** The optional Stripe module turns a paid checkout session into a
  `topup` row keyed on the session id, and Stripe redelivers until it is
  acknowledged.

The Stripe module speaks to the API over `fetch` and is two directories —
`apps/web/src/lib/v2/billing/` and `apps/web/src/app/api/billing/`. Nothing
outside them imports from them. `BILLING_ENABLED=true` without all three Stripe
variables fails at boot.

## What testing against real documents found

`v2.integration.test.ts` drives the API over documents it seeds by hand, and it
passed for the whole of this phase while four things were wrong. Each was found
by running real bytes through the real worker
(`v2-fixtures.integration.test.ts`) or by installing an SDK the way a user
would (`scripts/sdk-quickstart.sh`):

- **A repeated upload wrote two `cache_hit` rows.** Intake records the hit and
  so did the route. `resolveInput` now says whether intake already did.
- **`metered` refused everyone.** Nothing ever granted `STARTING_CREDITS`, so
  every organization's balance was zero and the mode was unusable. No test ran
  under it.
- **The TypeScript SDK could not upload a file.** It sent JSON always; its
  README showed an upload using a function that did not exist.
- **The Python SDK's generated module failed its own lint**, so its drift check
  could never have passed in CI — had CI run it.

The general lesson is the one `0003-retrieval.md` already records about the
eval: a harness that builds its own inputs measures the harness.

## Consequences

- An API change is a change to a Zod schema and a `pnpm codegen`; anything less
  does not merge.
- `ask` and `extract` do not survive a web-process restart mid-flight. Stated in
  the API reference; revisit by moving them behind the queue.
- A split output has no thumbnails and no figures until it is reparsed.
- Load is measured by a person with `pnpm load:parse` and `pnpm load:chat`
  (`load/README.md`), not by CI: a throughput figure from a shared runner is a
  measurement of the runner.
- Publishing the SDKs is `release-sdks.yml`, run by hand or by an `sdk-v*` tag,
  through OIDC trusted publishing — no registry token is stored in the
  repository.
