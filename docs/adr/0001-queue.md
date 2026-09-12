# ADR 0001 — The job transport is a Redis stream with a consumer group

- **Status:** accepted
- **Date:** 2026-09-12
- **Phase:** 06 — Worker service and the job contract

## Context

Konusbitr deliberately runs two languages. TypeScript owns the product surface
because the streaming-chat-UI ecosystem lives there; Python owns the document
pipeline because every serious PDF layout and OCR library is Python. The entire
contract between them is a queue plus JSON payloads — no shared ORM, no RPC
framework, no import in either direction — and that hard seam is what keeps a
two-language codebase contributable.

Which leaves one question: what carries the bytes.

The obvious answer is each ecosystem's own job library — [BullMQ] on the
TypeScript side, [arq] on the Python side. Both are good. Neither can talk to
the other. Their job *wrappers* are private formats, not wire protocols:

- **BullMQ** stores a job as a Redis hash with its own field names, a set of
  auxiliary keys (`wait`, `active`, `delayed`, `completed`, `failed`, a repeat
  ZSET, a metadata hash), and an atomic move between them implemented in Lua
  scripts that BullMQ ships and versions. A Python consumer would have to
  reimplement those scripts and keep them in step with BullMQ's releases.
- **arq** serialises a job with `msgpack` — a tuple of function name, args,
  kwargs, enqueue time and job try — into a Redis key, with the job id as a
  separate ordered set entry. A TypeScript producer would have to reimplement
  arq's encoding, including its pickling conventions for anything non-trivial.

Either way, one side would own a format the other side merely *imitates*. That
imitation is precisely the failure mode this architecture is built to avoid:
it drifts on a minor version bump of a library nobody in the other language is
watching, and it drifts silently, because a job that cannot be decoded looks
exactly like a queue that is quiet.

Phase 05 shipped a placeholder: `RPUSH` onto a list, with nothing consuming it.

[BullMQ]: https://docs.bullmq.io
[arq]: https://arq-docs.helpmanual.io

## Decision

**A Redis stream, `konusbitr:jobs`, with a single consumer group,
`konusbitr:workers`.** No BullMQ, no arq. Both runtimes speak the transport
directly, with each entry carrying one field, `payload`, holding the JSON of a
`JobPayload`.

The payload schema is defined once in Zod in `packages/shared` and the pydantic
model is generated from it by `pnpm codegen`; CI regenerates and fails on any
diff. The Redis key names are generated the same way, into the same file,
because a worker listening on the wrong stream is exactly as broken as one
parsing the wrong JSON and considerably harder to notice.

Around the stream sit two ordinary Redis structures:

| Key | Type | Purpose |
| --- | --- | --- |
| `konusbitr:jobs` | stream | the queue; `XADD` to enqueue, `XREADGROUP` to consume |
| `konusbitr:jobs:retry` | sorted set | jobs waiting out a backoff, scored by when they are due |
| `konusbitr:jobs:dead` | list | jobs that will never succeed, for an operator to read |
| `konusbitr:progress:{documentId}` | pub/sub | progress events, relayed to the browser over SSE |

## Why a stream and not the list Phase 05 wrote to

A list was the smaller change, and it is not good enough. `BLPOP` hands a job
to a worker and immediately forgets it existed, so a worker killed mid-parse
takes the job to the grave: the document sits at `parsing` forever and nothing
in Redis remembers that anyone was ever working on it.

A stream entry stays in the consumer group's pending-entries list until the
consumer acknowledges it. That gives the three things the phase's acceptance
criteria need and a list cannot provide:

- **Crash recovery.** A restarted worker rejoins under the same consumer name
  and reads its own pending entries with `XREADGROUP … STREAMS key 0`. The job
  it died inside is handed straight back to it.
- **Orphan adoption.** A replica that is killed and never returns leaves
  entries owned by a name nobody will use again; `XAUTOCLAIM` moves them to a
  live consumer after an idle period.
- **Visibility.** `XPENDING` answers "what is in flight, and for how long"
  without any bookkeeping of our own.

The cost is that acknowledgement is now the worker's responsibility, and that
at-least-once delivery has to be turned into exactly-once *effect* by making
every write idempotent — an upsert keyed on `(content_hash, settings_hash)` for
the parse, on `(document_id, page_no)` for pages, and a short-circuit when the
parse already exists. That work was required anyway: the docId cache means a
repeat upload must produce no new rows.

## Why exponential backoff needs its own sorted set

Redis streams have no delayed delivery. A failed job could be left in the
pending list for `XAUTOCLAIM` to pick up, but that gives every retry the same
fixed delay, which is the opposite of backoff — a dependency that is down stays
down while the worker hammers it.

So a retryable failure acknowledges the original entry and adds the payload,
with its attempt number incremented, to `konusbitr:jobs:retry` scored by the
epoch millisecond it becomes due. A one-second janitor pass moves due entries
back onto the stream. `ZREM` is the lock: several replicas may see the same due
entry, and only the one whose removal actually deleted it re-enqueues, so a
retry is promoted exactly once however many workers are running.

## Consequences

**Good.**

- One format, generated from one source, with CI failing on drift. Neither
  runtime imitates the other.
- The transport is ordinary Redis. Anybody can read the queue with
  `redis-cli`, and there is no library-specific tooling to learn or install.
- No dependency on either job library's release cadence, and no Lua.
- Idempotent writes are enforced by the schema rather than promised by the
  transport, which is the stronger guarantee.

**Bad.**

- We hand-roll the consumer loop: concurrency, per-job timeout, retry policy,
  dead-lettering and orphan adoption are about 250 lines in
  `services/worker/src/konusbitr_worker/{queue,runtime}.py`. A library would
  have given us those.
- No scheduling, no cron, no job dependencies, no rate limiting, no dashboard.
  If any of those become requirements, this decision should be revisited
  rather than extended.
- Redis persistence is now load-bearing for the queue. Compose runs Redis with
  AOF and `appendfsync everysec`, and a self-hoster who turns that off can
  lose an in-flight job.

**Neutral.**

- Trimming is explicit. `XADD … MAXLEN ~ 10000` caps the stream, because
  `XACK` only stops an entry being redeliverable and does not remove it.

## Alternatives considered

**BullMQ on both sides, with a Python reimplementation of its key layout.**
Rejected: the layout is BullMQ's internal detail, maintained in Lua, and the
reimplementation would break on a minor version bump with no test in the
TypeScript CI able to see it.

**arq on both sides, with a TypeScript reimplementation of its msgpack job.**
Rejected for the same reason, with the added problem that arq's serialisation
assumes Python types.

**A broker with a real cross-language protocol — RabbitMQ, NATS, Kafka.** All
solve the problem properly and all lose the headline feature: `cp .env.example
.env && docker compose up`. Redis is already in the stack for rate limiting and
progress pub/sub, and adding a fourth backing service to a self-hosted
deployment is a real cost paid by every user to save us 250 lines.

**Postgres as the queue (`SELECT … FOR UPDATE SKIP LOCKED`).** Genuinely
tempting — one fewer thing to persist, and transactional with the writes the
worker makes anyway. Rejected because it would put the Python worker's queue
reads in the same database as the application schema, which blurs the seam this
architecture depends on, and because progress already needs Redis pub/sub, so
Redis does not go away.

## Revisit when

- Jobs need scheduling, cron, dependencies between jobs, or per-tenant rate
  limiting. That is the point at which hand-rolling stops being cheaper.
- A deployment runs enough replicas that `XAUTOCLAIM` contention shows up.
- The retry sorted set needs priorities as well as a due time.
