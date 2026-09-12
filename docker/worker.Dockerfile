# syntax=docker/dockerfile:1.7
#
# The Python document pipeline. Build context is the repo root:
#
#   docker build -f docker/worker.Dockerfile .
#
# uv owns both the interpreter and the dependencies, and installs strictly from
# `uv.lock` — the image can never resolve a version the repo has not pinned.
# Builds on linux/amd64 and linux/arm64.
#
# This runs the real job loop: a FastAPI app serving /health and /ready, with
# the Redis-stream consumer started from its lifespan. The parse itself is a
# stub until Phase 07; nothing about the image changes when that lands.

ARG PYTHON_VERSION=3.12
ARG UV_VERSION=0.12

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv-bin

# --------------------------------------------------------------------- base --
FROM python:${PYTHON_VERSION}-slim AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DO_NOT_TRACK=1

# --------------------------------------------------------------------- deps --
FROM base AS deps
COPY --from=uv-bin /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src

# Dependencies first, without the project, so an edit to worker source does not
# re-resolve or re-download anything.
COPY services/worker/pyproject.toml services/worker/uv.lock services/worker/.python-version ./
RUN --mount=type=cache,id=uv-cache,target=/root/.cache/uv \
    uv sync --locked --no-install-project --no-dev --no-editable

# `--no-editable` matters: the default editable install would leave the venv
# pointing at /src, which does not exist in the runtime stage.
COPY services/worker/ ./
RUN --mount=type=cache,id=uv-cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable

# ------------------------------------------------------------------ runtime --
FROM base AS runtime
ENV PATH=/opt/venv/bin:$PATH \
    VIRTUAL_ENV=/opt/venv \
    WORKER_PORT=8081 \
    KONUSBITR_WORKER_HEARTBEAT=/var/run/konusbitr/worker.heartbeat

# A dedicated unprivileged user; the slim image has no equivalent of node's.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin konusbitr \
    && mkdir -p /var/run/konusbitr \
    && chown konusbitr:konusbitr /var/run/konusbitr

COPY --from=deps --chown=konusbitr:konusbitr /opt/venv /opt/venv

USER konusbitr
WORKDIR /home/konusbitr

# Health and readiness only. Nothing in the app calls the worker.
EXPOSE 8081

# Probes the worker's own /health over loopback, which reports the job loop's
# heartbeat as well as Redis connectivity — so an image that boots but stops
# consuming is reported unhealthy rather than merely "running". Python's own
# urllib does the request; the slim image ships no curl and does not need one.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD ["python", "-m", "konusbitr_worker.health"]

CMD ["python", "-m", "konusbitr_worker"]
