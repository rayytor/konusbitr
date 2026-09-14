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
# the Redis-stream consumer started from its lifespan, and the parse pipeline
# behind it: PDFium for structure and thumbnails, Docling for layout, and the
# Phase 12.1 OCR tier for pages that have no text layer at all.
#
# Docling's layout models are **baked into the image** rather than fetched on
# first use. A worker that downloads several hundred megabytes from Hugging
# Face the first time somebody uploads a document is a worker that fails in an
# air-gapped deployment, fails behind a corporate proxy, and turns the first
# parse after every deploy into a two-minute one. OFFLINE_MODE is a headline
# claim of this project; a model downloaded at runtime would quietly break it.
# RapidOCR needs no equivalent step: its PP-OCRv4 weights ship inside the wheel
# and are installed by `uv sync` along with everything else.
#
# Every package in the default image is Apache-2.0, MIT or BSD-3.
# `services/worker/tests/test_licensing.py` fails the build if that stops being
# true, which is what keeps AGPL dependencies behind the `advanced` profile.

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

# ------------------------------------------------------------------- models --
# Fetched once at build time into a directory the runtime stage copies. Cached
# as its own layer, so an edit to worker source never re-downloads them.
FROM deps AS models
ENV DOCLING_ARTIFACTS_PATH=/opt/docling-models \
    HF_HUB_DISABLE_TELEMETRY=1
RUN /opt/venv/bin/docling-tools models download --output-dir /opt/docling-models layout tableformer

# ------------------------------------------------------------------ runtime --
FROM base AS runtime
ENV PATH=/opt/venv/bin:$PATH \
    VIRTUAL_ENV=/opt/venv \
    WORKER_PORT=8081 \
    KONUSBITR_WORKER_HEARTBEAT=/var/run/konusbitr/worker.heartbeat

# DOCLING_ARTIFACTS_PATH is where Docling looks for the weights baked in above;
# without it Docling reaches for Hugging Face at first use, which is the failure
# this image exists to avoid, and HF_HUB_OFFLINE makes that attempt fail loudly
# rather than hang. OMP_NUM_THREADS is capped because torch sizes its pool from
# the *host's* core count — inside a CPU-limited container that is dozens of
# threads fighting over two cores. WORKER_PARSE_THREADS is the knob that should
# decide parse parallelism.
ENV DOCLING_ARTIFACTS_PATH=/opt/docling-models \
    HF_HUB_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    OMP_NUM_THREADS=4

# Three system packages, for two different reasons.
#
# OpenCV arrives through Docling's layout models and the OCR preprocessing
# chain, and links against the system GL and glib shared objects, which
# `python:slim` does not ship. Without them the image builds cleanly and then
# fails on the first import, at the first job — the worst place to discover a
# missing library.
#
# `tesseract-ocr` is the OCR tier's fallback engine, reached when RapidOCR is
# unsure about a page. `pytesseract` is only a wrapper around this binary, and
# a deployment without it keeps working with the primary engine alone rather
# than failing — but the default image should carry both, because "the fallback
# exists" is a claim the phase makes. `tesseract-ocr-eng` is its English
# traineddata; `OCR_LANGUAGES` names which sets are loaded, and adding a
# language means adding its `tesseract-ocr-<lang>` package here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        tesseract-ocr \
        tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

# A dedicated unprivileged user; the slim image has no equivalent of node's.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin konusbitr \
    && mkdir -p /var/run/konusbitr \
    && chown konusbitr:konusbitr /var/run/konusbitr

COPY --from=deps --chown=konusbitr:konusbitr /opt/venv /opt/venv
COPY --from=models --chown=konusbitr:konusbitr /opt/docling-models /opt/docling-models

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
