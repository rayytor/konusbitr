# docker/

Dockerfiles and Compose fragments for the self-hosted stack: Postgres with
pgvector, Redis, MinIO, the Next.js web app, and the Python worker.

Placeholder until **Phase 02 — Local Infrastructure**, which makes
`docker compose up` bring up the whole stack. Optional profiles land with it:
`local-llm` (Ollama) and `advanced` (the restrictively-licensed parser extras
that must stay out of the default build).
