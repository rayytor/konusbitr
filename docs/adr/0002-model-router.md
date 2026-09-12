# ADR 0002 — LiteLLM as the single model interface, with independent roles

**Status:** accepted, Phase 08.
**Supersedes:** nothing.

## Context

Konusbitr talks to language models for four different jobs — chat, embedding,
reranking, and vision — and it has to talk to them from two runtimes. The
product surface is TypeScript and the document pipeline is Python, and both need
to reach the same models, configured by the same operator, out of the same
`.env`.

The deployments this project exists for do not agree about where those models
should run. A self-hoster on a laptop wants OpenAI and a credit card. A law firm
wants a cloud chat model but will not let document text leave the building, so
embeddings have to be local. A government install wants everything local and
nothing outbound at all, and that last case is not a preference — it is the
reason the software was chosen.

So the question is not "which provider" but "how is the provider not a decision
the code makes".

## Decision

**Every model call goes through one router, and no Konusbitr module imports a
provider SDK.** In the Python worker that router is
[LiteLLM](https://github.com/BerriAI/litellm); in the product surface it is
`packages/ai`, which speaks the OpenAI-compatible HTTP API directly.

**The four roles are configured independently.** `CHAT_PROVIDER`,
`EMBEDDING_PROVIDER`, `RERANK_PROVIDER` and `VISION_PROVIDER` each fall back to
`LLM_PROVIDER`, so the common case is one variable and the mixed case is two.

**`OFFLINE_MODE=true` is enforced twice.** Once at boot, where a cloud provider
named for *any* role fails the process before it serves traffic, and again at
every call site, because configuration can change under a running process and a
guarantee that lapses at the next deploy is not a guarantee.

**The embedding width is fixed at 1024.** `chunks.embedding` is
`vector(1024)`, because pgvector cannot build an HNSW index over a column whose
dimension it does not know. 1024 is BGE-M3's native width and a width
`text-embedding-3-large` supports through Matryoshka truncation, which is what
makes cloud and local interchangeable behind one column.

## Why LiteLLM rather than the alternatives

**Provider SDKs directly.** Rejected. It makes the provider a build-time
decision: supporting six of them means six code paths, and "run this offline
against Ollama" becomes a feature request rather than a variable. It also makes
the offline promise unenforceable — there would be no single place to refuse a
call.

**The Vercel AI SDK on both sides.** It is excellent, and Phase 10 will use it
for streaming chat in TypeScript. But it is TypeScript-only, and the pipeline
that needs embeddings is Python. Using it as *the* router would mean the worker
calling the web app to embed a chunk, which puts an HTTP hop and a second
service in the middle of the hot path of every document.

**A LiteLLM proxy as a required service.** This is a real option and it is
*supported* — `LLM_BASE_URL` points everything at one. But requiring it would
add a container to `docker compose up`, and the headline claim of this project
is that one command produces a working stack. So the library form is the
default and the proxy is an option.

**An OpenAI-compatible client alone, in both runtimes.** Tempting, because it is
what `packages/ai` does. It works for embeddings, where every provider in the
allowlist serves `/v1/embeddings`. It does not work for chat against Anthropic
or Google Vertex without reimplementing their request shapes — which is
precisely the work LiteLLM has already done and keeps doing.

## Consequences

The worker's image carries LiteLLM and its transitive `openai` and `tiktoken`
dependencies. That is a real cost on top of Docling and Torch, and it buys the
tokenizer the chunker measures with as well as the provider abstraction.

The two halves of the router are *separate implementations of one contract*,
which is the same shape — and the same risk — as the job payload. The contract
is the vocabulary in `packages/shared/src/models.ts` and
`konusbitr_worker.settings`: role names, the local/cloud partition, and the
environment variables. Unlike the job payload it is **not generated**, because
it is configuration rather than a wire format and `settings.py` has to be
importable before any code generation has run. Both sides assert it in their own
tests instead.

`RERANK_MODEL` has no default. Reranker choices differ enough that guessing one
would silently change retrieval quality, so Phase 09 configures one explicitly
or falls back to fusion alone.

## When to revisit

- If a provider Konusbitr wants to support is not routable by LiteLLM and not
  OpenAI-compatible, the abstraction has stopped paying for itself in that
  direction and a direct adapter behind the same interface is the answer.
- If the worker's image size becomes the binding constraint on self-hosting, the
  proxy form — one small container, no library in the worker — trades an image
  for a service and is worth re-costing.
- If a deployment genuinely needs two *different* cloud providers across roles,
  `LLM_API_KEY` has to become per-role. It is one variable today because mixing
  two paid providers is rare and four more variables is not free.
