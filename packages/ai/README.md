# `@konusbitr/ai`

The TypeScript half of the model router, and the home of every versioned prompt.

## Why a router at all

Konusbitr never imports a provider SDK. Every model call in the product goes
through one interface whose four roles — `chat`, `embedding`, `rerank`,
`vision` — are configured independently, because the deployments this project
exists for genuinely mix them: a law firm runs a cloud chat model and keeps
embeddings local so document text never leaves the building, and a government
install runs everything local. Neither shape is expressible if the provider is
a build-time import.

The Python worker's half of this is `konusbitr_worker.ai`, which wraps
[LiteLLM](https://github.com/BerriAI/litellm). This package is the same
contract for the product surface, spoken over the OpenAI-compatible HTTP API
that every provider in the allowlist — and LiteLLM's own proxy — serves. The
two halves share their vocabulary through `@konusbitr/shared`: the role names,
the provider partition, and the environment contract are declared once.

## Offline mode

`OFFLINE_MODE=true` is a headline claim, so it is enforced twice. Once at boot,
in `EnvSchema`, where a cloud provider named for any role fails the process.
And again here, at the call site, in `assertReachable` — because an operator can
change configuration under a running process, and a claim that holds only until
the next `kubectl set env` is not a claim.

## Layout

- `src/roles.ts` — resolve a role to a concrete endpoint, model and credential.
- `src/offline.ts` — what "local" means, and the refusal when it is violated.
- `src/resilience.ts` — retry with backoff, and the per-role circuit breaker.
- `src/usage.ts` — token and cost accounting, emitted per call for Langfuse.
- `src/embed.ts` — embeddings over the OpenAI-compatible route.
- `prompts/` — versioned prompt files. Never an inline string literal, so that
  an eval score moving can be attributed to a prompt changing.
