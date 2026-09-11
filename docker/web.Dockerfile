# syntax=docker/dockerfile:1.7
#
# The Next.js web app. Build context is the repo root:
#
#   docker build -f docker/web.Dockerfile .
#
# Multi-stage so that the runtime image carries only Next.js standalone output
# and its traced dependencies — no pnpm store, no source, no dev toolchain.
# Builds on linux/amd64 and linux/arm64; nothing here is architecture-specific,
# so BuildKit's native cross-platform support handles both.

ARG NODE_VERSION=22.13.0

# --------------------------------------------------------------------- base --
FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
# Install pnpm directly to avoid Corepack key/signature mismatch
RUN npm install -g pnpm@11.25.0
WORKDIR /app

# --------------------------------------------------------------------- deps --
# `pnpm fetch` populates the store from the lockfile alone, so this layer is
# invalidated only by a dependency change — not by every source edit.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch

# -------------------------------------------------------------------- build --
FROM deps AS build
COPY . .
# `--ignore-scripts` because the only lifecycle scripts this repo allows are a
# formatter, a bundler and a git-hook installer, none of which a production
# build needs — and the git-hook one would fail anyway, since `.git` is not in
# the build context.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline --ignore-scripts
RUN pnpm --filter @konusbitr/web build

# ------------------------------------------------------------------ runtime --
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app

# `node` (uid 1000) ships with the image. Running as root in a container a
# self-hoster exposes to a network is not a default worth shipping.
USER node

# Standalone output is a self-contained server plus exactly the files Next
# traced as reachable. `outputFileTracingRoot` in next.config.ts points at the
# repo root so workspace packages are traced too, which is why the layout below
# is nested under apps/web.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public

EXPOSE 3000

# Same probe Compose uses, so `docker run` on its own reports health too.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
