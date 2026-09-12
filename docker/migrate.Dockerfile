# syntax=docker/dockerfile:1.7
#
# The database migrator. Build context is the repo root:
#
#   docker build -f docker/migrate.Dockerfile .
#
# This runs as a one-shot before web and worker start, which is what makes
# `docker compose up` on an empty volume produce a database anyone can sign up
# against. It is deliberately its own image rather than an entrypoint on the web
# image: the web runtime carries only Next.js standalone output, with no source,
# no tsx and no SQL files, and keeping it that way is worth more than saving a
# layer.
#
# It stays small by never building the app — only `@konusbitr/db` and its
# dependencies are installed, so this image is seconds to build even when the
# web image is minutes.

ARG NODE_VERSION=22.13.0

FROM node:${NODE_VERSION}-alpine
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
# Install pnpm directly to avoid Corepack key/signature mismatch
RUN npm install -g pnpm@11.25.0
WORKDIR /app

COPY . .

# `--prod` keeps drizzle-kit, Vitest and Testcontainers out of a runtime image
# that only has to apply SQL; `--ignore-scripts` for the same reason as the web
# image, where the one lifecycle script that matters would fail anyway with no
# `.git` in the build context.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline --ignore-scripts --prod \
      --filter @konusbitr/db...

# The migration runner is TypeScript, and `--prod` just dropped the loader that
# runs it. Installed globally rather than restored to the workspace so that the
# production tree stays production.
RUN npm install -g tsx@4.23.13

# `node` (uid 1000) ships with the image; nothing here needs root.
USER node

# Idempotent: already-applied migrations are skipped, so restarting the stack or
# re-running `docker compose up` costs one round trip to Postgres.
CMD ["pnpm", "--filter", "@konusbitr/db", "db:migrate"]
