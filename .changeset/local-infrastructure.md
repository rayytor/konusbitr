---
'@konusbitr/shared': minor
---

Add the environment contract: `EnvSchema`, `parseEnv` and `loadEnv` validate
every variable the stack needs at process start and fail with a message naming
each offending one, rather than lazily at first use. The pydantic-settings half
lives in `konusbitr_worker.settings` and its tests mirror these, so the two
runtimes cannot quietly disagree about what `.env` means.
