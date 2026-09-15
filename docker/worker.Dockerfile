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
#
# That profile is the `worker-advanced` stage at the bottom of this file. It is
# never reached by a default build — `docker build .` stops at `runtime`, and
# only `--target worker-advanced --build-arg ENABLE_ADVANCED_PARSERS=true`
# installs the AGPL and GPL extras. Building it changes the licence of the
# resulting image; `docs/licensing.md` says exactly how.

ARG PYTHON_VERSION=3.12
ARG UV_VERSION=0.12

# Opt-in to the restrictively-licensed parsers. Only the `worker-advanced` stage
# reads it, and that stage refuses to build without it — see the bottom of this
# file for why a build argument that merely defaults to false was not enough.
ARG ENABLE_ADVANCED_PARSERS=false

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
# `tesseract-ocr` is the OCR tier's second engine. Until Phase 12.2 it was only
# the *fallback*, reached when RapidOCR was unsure about a page; it is now also
# the **primary** engine for the languages RapidOCR's shipped weights cannot
# read — Arabic and Hebrew, which are contextually shaped, and Turkish and
# Japanese, whose PP-OCR recognition heads are separate downloads this image
# deliberately does not fetch. `pytesseract` is only a wrapper around this
# binary, and a deployment without it keeps working with the primary engine
# alone rather than failing.
#
# The language packs below are the ones `konusbitr_worker.parse.ocr.languages`
# routes to, and they are the difference between reading a Turkish contract and
# reading a Turkish contract with every diacritic silently dropped. Together
# they add roughly 60MB to the image, which is the price of the phase's headline
# claim. Adding another language is one line here plus nothing else:
# `OCR_LANGUAGES` and `settings.langList` both name traineddata that either is
# installed or is not, and the router falls back rather than failing when it is
# not.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        tesseract-ocr \
        tesseract-ocr-eng \
        tesseract-ocr-ara \
        tesseract-ocr-chi-sim \
        tesseract-ocr-chi-tra \
        tesseract-ocr-deu \
        tesseract-ocr-fra \
        tesseract-ocr-heb \
        tesseract-ocr-hin \
        tesseract-ocr-ita \
        tesseract-ocr-jpn \
        tesseract-ocr-kor \
        tesseract-ocr-nld \
        tesseract-ocr-por \
        tesseract-ocr-rus \
        tesseract-ocr-spa \
        tesseract-ocr-tur \
        tesseract-ocr-ukr \
        tesseract-ocr-vie \
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

# --------------------------------------------------------- advanced (opt-in) --
#
# **This stage installs AGPL-3.0 and GPL-3.0 packages. It is not part of the
# default build and an image produced from it may not be redistributed under
# Apache-2.0.** Read `docs/licensing.md` first.
#
#   docker build -f docker/worker.Dockerfile \
#     --target worker-advanced \
#     --build-arg ENABLE_ADVANCED_PARSERS=true .
#
# Reached through Compose only as `docker compose --profile advanced up`, which
# builds this target and nothing else does.
#
# Two locks, and both are needed. The packages live in the `advanced` extra in
# `pyproject.toml`, so `uv sync --no-dev` — what every other stage runs — cannot
# install them however it is invoked. And this stage *fails the build* when
# `ENABLE_ADVANCED_PARSERS` is not `true`, rather than quietly producing an
# image identical to `runtime`. A silent no-op would mean somebody could target
# this stage, get a clean image, and believe they had the advanced parsers —
# then discover at the first document that they did not. A licence boundary that
# can be crossed by accident is not one; neither is one that can be *missed* by
# accident.
FROM runtime AS worker-advanced

ARG ENABLE_ADVANCED_PARSERS
USER root

COPY --from=uv-bin /uv /usr/local/bin/uv
COPY docker/advanced-requirements.txt /tmp/advanced-requirements.txt

# Installed from a pinned requirements file rather than from a `pyproject.toml`
# extra, and that file explains why at length: both packages pin `pillow<11`,
# the default build needs `pillow>=11`, and uv resolves extras together with the
# base dependencies — so as an extra they would have decided which Pillow the
# *Apache-2.0* image ships. A dependency nobody installs must not be able to
# touch the image everybody runs.
RUN if [ "${ENABLE_ADVANCED_PARSERS}" != "true" ]; then \
      echo "worker-advanced: refusing to build without ENABLE_ADVANCED_PARSERS=true." >&2; \
      echo "This stage installs AGPL-3.0 and GPL-3.0 packages; see docs/licensing.md." >&2; \
      exit 1; \
    fi \
    && VIRTUAL_ENV=/opt/venv uv pip install --requirement /tmp/advanced-requirements.txt \
    && rm -f /tmp/advanced-requirements.txt \
    && rm -rf /root/.cache/uv \
    && chown -R konusbitr:konusbitr /opt/venv

# Announced in the environment rather than inferred from an import that may or
# may not have succeeded. `konusbitr_worker.parse.advanced` reads it to decide
# whether to *look* for the packages at all, so a default image never pays an
# import error to learn what it already knows.
ENV KONUSBITR_ADVANCED_PARSERS=true

USER konusbitr
WORKDIR /home/konusbitr

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD ["python", "-m", "konusbitr_worker.health"]

CMD ["python", "-m", "konusbitr_worker"]
