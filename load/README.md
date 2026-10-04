# Load tests

[k6](https://k6.io) scripts for the two numbers Phase 13 asks for. They are run
by a person against a stack they chose, not by CI: a throughput figure measured
on a shared CI runner is a measurement of the runner.

| Script | Measures | Threshold |
| --- | --- | --- |
| `k6/parse.js` | `/v2/parse` — cold (never-seen bytes, through the worker) and cached (by `docId`) | cold p95 < 20s for the 10-page fixture; cached p95 < 500ms |
| `k6/chat-ttft.js` | `POST /api/chat` time to first stream event | p95 < 1.5s |

## Running

Bring a stack up, create an API key under **Settings → API keys** with the
`parse` and `chat` scopes, and:

```bash
KONUSBITR_API_KEY=kb_... pnpm load:parse
```

```bash
KONUSBITR_API_KEY=kb_... pnpm load:chat
```

Both scripts use k6 if it is installed and the `grafana/k6` container if it is
not. `KONUSBITR_URL` points them somewhere other than `http://localhost:3000`.

Two things to set on the instance under test first:

- **Rate limits.** The defaults are sized for an integration, not a load
  generator. Raise `RATE_LIMIT_PER_KEY_PER_MINUTE` and
  `RATE_LIMIT_PER_ORG_PER_MINUTE`, or set `RATE_LIMIT_ENABLED=false`. A `429`
  counts as a failed check, so a throttled run cannot pass as a fast one.
- **A chat model**, for `chat-ttft.js`. The script fails a stream that carried
  no text, so it cannot be satisfied by an instance with no model configured.

## What the numbers mean

`parse.js` runs two scenarios because "how fast is parse" is two questions. The
cold scenario appends a unique PDF comment to the fixture on every iteration,
which changes its hash and misses the docId cache; it measures the pipeline and
is a closed loop of `COLD_VUS` callers (default 2, matching the default
`WORKER_CONCURRENCY`), so the latency it reports is a parse and not a queue.
Raise it alongside the worker pool. Throughput is `parse_pages` per second. The
cached scenario is the call an integration makes most, and does no work by
design.

`chat-ttft.js` reports `http_req_waiting` — request sent to first byte of the
stream. The chat endpoint writes a `retrieving` event before it does anything
else, so the first byte *is* the first event a reader sees, which is the
product's definition of the 1.5s budget. It is not the first token of the
model's prose; that depends on the provider.
