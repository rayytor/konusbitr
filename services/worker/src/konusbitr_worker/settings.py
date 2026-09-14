"""Runtime configuration for the worker, validated once at process start.

This is the Python half of the environment contract. The TypeScript half lives
in ``packages/shared/src/env.ts`` and the two describe the same variables from
the same ``.env``; ``.env.example`` documents both.

Konusbitr fails loudly at boot rather than lazily at first use. A worker that
starts with an unset ``REDIS_URL`` and only notices when the first job arrives
has turned a one-line configuration mistake into an incident, so
:func:`load_settings` raises with every offending variable named.

Unlike the job payload models in :mod:`konusbitr_worker.contracts`, which are
generated from the Zod schemas, this module is hand-written: it is
configuration rather than a wire format, and it must be importable before any
code generation has run.

The ``WORKER_*`` variables at the bottom have no TypeScript counterpart, in the
same way ``AUTH_SECRET`` has no Python one. The shared half of the contract is
the part that is genuinely shared; how many jobs this process runs at once is
nobody else's business.
"""

from __future__ import annotations

import os
import socket
from pathlib import Path
from typing import Any, Literal, Self
from urllib.parse import urlparse

from pydantic import ValidationError, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

__all__ = [
    "CLOUD_PROVIDERS",
    "DEFAULT_CHAT_MODELS",
    "DEFAULT_EMBEDDING_MODELS",
    "LOCAL_PROVIDERS",
    "MODEL_ROLES",
    "PROVIDERS_WITHOUT_EMBEDDINGS",
    "ROLE_PROVIDER_VARIABLE",
    "EnvValidationError",
    "LlmProvider",
    "ModelRole",
    "Settings",
    "is_local_endpoint",
    "load_settings",
]

NodeEnv = Literal["development", "test", "production"]
LlmProvider = Literal["openai", "anthropic", "google", "mistral", "ollama", "vllm", "cohere"]
CreditsMode = Literal["unlimited", "metered"]

#: What a model is being asked to do.
#:
#: Mirrors ``MODEL_ROLES`` in ``packages/shared/src/models.ts``. Hand-written
#: rather than generated, because this is the *environment* contract rather than
#: a wire payload — the generated ``contracts`` module covers what crosses the
#: Redis seam, and this module has to be importable before any code generation
#: has run. ``tests/test_settings.py`` pins it against the TypeScript half.
ModelRole = Literal["chat", "embedding", "rerank", "vision"]

MODEL_ROLES: tuple[ModelRole, ...] = ("chat", "embedding", "rerank", "vision")

#: Providers that run on hardware the operator controls. This is the whole of
#: the definition of "local", and what ``OFFLINE_MODE=true`` permits.
LOCAL_PROVIDERS: tuple[LlmProvider, ...] = ("ollama", "vllm")

#: Everything else: an endpoint on somebody else's computer.
CLOUD_PROVIDERS: tuple[LlmProvider, ...] = (
    "openai",
    "anthropic",
    "google",
    "mistral",
    "cohere",
)

#: Providers that serve chat or rerank but expose no embedding endpoint this
#: router can address.
PROVIDERS_WITHOUT_EMBEDDINGS: tuple[LlmProvider, ...] = (
    "anthropic",
    "google",
    "cohere",
)

#: The variable that names a role's provider, for error messages.
ROLE_PROVIDER_VARIABLE: dict[ModelRole, str] = {
    "chat": "CHAT_PROVIDER",
    "embedding": "EMBEDDING_PROVIDER",
    "rerank": "RERANK_PROVIDER",
    "vision": "VISION_PROVIDER",
}

#: The model each provider gets when only a provider is named, in LiteLLM's
#: ``provider/model`` spelling. ``vllm`` serves whatever was loaded into it, so
#: it has no default worth inventing.
DEFAULT_EMBEDDING_MODELS: dict[LlmProvider, str] = {
    "openai": "text-embedding-3-large",
    "mistral": "mistral-embed",
    "ollama": "ollama/bge-m3",
}

DEFAULT_CHAT_MODELS: dict[LlmProvider, str] = {
    "openai": "gpt-4.1-mini",
    "anthropic": "claude-sonnet-4-5",
    "google": "gemini/gemini-2.5-flash",
    "mistral": "mistral-small-latest",
    "ollama": "ollama/llama3.2:3b",
}


def is_local_endpoint(value: str) -> bool:
    """Whether a URL points at this machine or this network.

    Shape rather than DNS: this runs at boot and in the hot path of every model
    call, and a resolver lookup would be both slow and a second thing that can
    fail. A bare hostname with no dot is a container or service name and is by
    construction not a public DNS name. The resolving, SSRF-grade guard lives in
    ``apps/web/src/lib/ingest/ssrf.ts`` and exists for a different job:
    user-supplied URLs. These endpoints come from the operator's own ``.env``.
    """
    hostname = urlparse(value).hostname
    if not hostname:
        return False
    if hostname == "localhost" or hostname.endswith(".localhost"):
        return True
    if hostname == "::1":
        return True
    if "." not in hostname:
        return True

    parts = hostname.split(".")
    if len(parts) != 4 or not all(part.isdigit() for part in parts):
        return False
    first, second = int(parts[0]), int(parts[1])
    if first in (10, 127):
        return True
    if first == 192 and second == 168:
        return True
    return first == 172 and 16 <= second <= 31


class EnvValidationError(RuntimeError):
    """Raised with a message an operator can act on from the container log alone."""

    def __init__(self, message: str, issues: list[str]) -> None:
        super().__init__(message)
        self.issues = issues


def _find_env_file() -> Path | None:
    """Locate the repo-root ``.env`` by walking up from the working directory.

    Searching rather than hard-coding a relative path keeps ``uv run`` working
    from both ``services/worker`` and the repo root. In a container there is no
    ``.env`` on disk at all — Compose injects the variables directly — and this
    correctly finds nothing.
    """
    override = os.environ.get("KONUSBITR_ENV_FILE")
    if override:
        candidate = Path(override)
        return candidate if candidate.is_file() else None

    for directory in (Path.cwd(), *Path.cwd().parents):
        candidate = directory / ".env"
        if candidate.is_file():
            return candidate
    return None


def _require_url(value: str, schemes: tuple[str, ...], label: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in schemes or not parsed.netloc:
        raise ValueError(f"must be a valid {label} URL")
    return value


class Settings(BaseSettings):
    """Every variable the worker reads, with the same defaults as the Zod schema."""

    model_config = SettingsConfigDict(
        # Resolved per-instantiation by `load_settings`, never baked in at import
        # time: a module-level lookup would freeze whichever `.env` happened to
        # exist when the module was first imported.
        env_file=None,
        env_file_encoding="utf-8",
        case_sensitive=False,
        # The web app has variables the worker does not, and the same `.env`
        # feeds both.
        extra="ignore",
        frozen=True,
    )

    node_env: NodeEnv = "development"
    app_url: str

    database_url: str
    redis_url: str

    s3_endpoint: str
    s3_region: str = "us-east-1"
    s3_bucket: str
    s3_access_key_id: str
    s3_secret_access_key: str
    s3_force_path_style: bool = False

    # Ingest limits. The worker re-checks them because a job payload arrives
    # from a queue, not from the endpoint that first validated the upload.
    max_upload_bytes: int = 500 * 1024 * 1024
    max_pages: int = 0
    allow_global_parse_cache: bool = False

    #: The extractable-character coverage a page must reach for the standard
    #: parser to treat it as born-digital. See `.env.example`.
    text_coverage_threshold: float = 0.1

    # ── The OCR tier ─────────────────────────────────────────────────────────
    #
    # Phase 12.1. These are worker-only in the same sense `WORKER_CONCURRENCY`
    # is: recognition happens here and nowhere else, and the web app has no
    # decision to make about any of them. They are documented in `.env.example`
    # alongside the shared variables because an operator sets them in the same
    # file.

    #: Whether scanned pages are recognised at all.
    #:
    #: On by default, which is the Phase 12.1 change in one line: a scan that
    #: Phase 07 refused now parses. Turning it off restores that refusal
    #: exactly — a deployment that would rather see `needs_ocr` than a
    #: machine's reading of a photocopy is a legitimate position, and it is one
    #: variable.
    ocr_enabled: bool = True

    #: What scanned pages are rendered at before recognition.
    #:
    #: 300 is what both engines are trained around. Raising it makes pages
    #: quadratically more expensive for very little accuracy; lowering it makes
    #: body text too small to recognise. It is a knob because faint 6pt
    #: footnotes on a legal exhibit are a real case for 400, not because it
    #: wants routine tuning.
    ocr_dpi: float = 300.0

    #: Primary-engine page confidence below which the fallback engine is tried.
    ocr_fallback_threshold: float = 0.65

    #: Page confidence below which the viewer warns the reader to check the
    #: text. Not a failure threshold: the page is stored and indexed either way.
    ocr_low_confidence_threshold: float = 0.85

    #: Whether the fallback engine is consulted at all. Off is a supported
    #: state — and is what a deployment with no `tesseract` binary gets anyway,
    #: without having to say so.
    ocr_fallback_enabled: bool = True

    #: Whether skewed pages are straightened before recognition.
    ocr_deskew: bool = True

    #: Tesseract traineddata names, joined with `+`. Script auto-detection is
    #: Phase 12.2; until then this is what the fallback is told to expect.
    ocr_languages: str = "eng"

    # ── The model router ─────────────────────────────────────────────────────
    #
    # Every model call goes through LiteLLM; nothing here imports a provider
    # SDK. Roles are configured independently and each falls back to
    # ``llm_provider``, so the common case is one variable and the mixed case
    # — cloud chat, local embeddings, which is the shape a law firm wants — is
    # two. The TypeScript half of this contract is ``EnvSchema``; the defaults
    # on both sides have to match, and ``.env.example`` documents both.

    llm_provider: LlmProvider = "openai"
    llm_api_key: str | None = None
    #: An OpenAI-compatible base URL to route everything through: a LiteLLM
    #: proxy, a gateway, an air-gapped mirror.
    llm_base_url: str | None = None

    chat_provider: LlmProvider | None = None
    llm_chat_model: str | None = None

    embedding_provider: LlmProvider | None = None
    embedding_model: str | None = None

    #: The width ``chunks.embedding`` is declared at. A model that returns
    #: anything else cannot be stored: pgvector needs a fixed dimension to
    #: build an HNSW index, so the column is ``vector(1024)`` and the worker
    #: refuses the write rather than letting a batch insert fail inside
    #: Postgres. Changing it is a migration plus a full reindex.
    embedding_dimensions: int = 1024
    #: Passages per embedding request.
    embedding_batch_size: int = 64

    rerank_provider: LlmProvider | None = None
    rerank_model: str | None = None

    vision_provider: LlmProvider | None = None
    vision_model: str | None = None

    ollama_base_url: str = "http://localhost:11434"
    vllm_base_url: str | None = None

    #: Attempts per model call, the first included.
    model_max_retries: int = 3
    #: Per-call deadline for chat, rerank and vision.
    model_timeout_seconds: float = 60.0
    #: Per-call deadline for one embedding batch, which is slower than a chat turn.
    embedding_timeout_seconds: float = 120.0
    #: Consecutive failures that open a role's circuit.
    model_breaker_failures: int = 5
    #: How long an open circuit refuses calls before letting one through.
    model_breaker_cooldown_seconds: float = 30.0

    #: When true, any attempt to reach a non-local endpoint raises immediately.
    #:
    #: Enforced here at boot — a cloud provider named for *any* role fails the
    #: process — and again at every call site in
    #: :mod:`konusbitr_worker.ai`, because configuration can change under a
    #: running process and a guarantee that lapses at the next deploy is not a
    #: guarantee. It is a headline claim of the project, so it is tested.
    offline_mode: bool = False

    # ── The chunker ──────────────────────────────────────────────────────────
    #
    # The band is 600 to 900 tokens: long enough for a passage to answer a
    # question on its own, short enough that eight of them fit in a prompt with
    # room for an answer. ``chunk_max_tokens`` is the hard ceiling a merge may
    # not cross, and the 15% overlap is what keeps a sentence straddling a
    # boundary retrievable from either side.
    chunk_target_tokens: int = 800
    chunk_min_tokens: int = 600
    chunk_max_tokens: int = 1100
    chunk_overlap_ratio: float = 0.15

    # Phase 09's retrieval knobs — RERANK_ENABLED, HYDE_ENABLED,
    # MULTI_QUERY_ENABLED, CORPUS_TWO_STAGE_THRESHOLD, HNSW_EF_SEARCH — are
    # deliberately absent. Retrieval runs entirely in TypeScript, so the worker
    # has nothing to do with any of them, and `extra="ignore"` above means the
    # shared `.env` carrying them is not a problem. A setting declared here that
    # nothing reads is worse than no setting at all: it reads as a promise that
    # the worker honours it.

    billing_enabled: bool = False
    credits_mode: CreditsMode = "unlimited"

    # ── Worker-only ──────────────────────────────────────────────────────────

    #: Where the health and readiness endpoints listen.
    #: A container has to bind every interface for Compose to reach it.
    worker_host: str = "0.0.0.0"
    worker_port: int = 8081

    #: How many jobs this process runs at once.
    worker_concurrency: int = 2

    #: A job that has not finished in this long is abandoned and retried.
    worker_job_timeout_seconds: int = 600

    #: Total deliveries of one job before it is dead-lettered, first included.
    worker_max_attempts: int = 3

    #: Backoff base: attempt *n* waits ``base * 2 ** (n - 1)`` seconds.
    worker_retry_base_seconds: float = 5.0

    #: Size of the thread pool the parser's blocking work runs on.
    #:
    #: Docling and PDFium are synchronous and CPU-bound; the event loop that
    #: also has to keep publishing progress and answering `/health` must not be
    #: the thread doing them. Kept small on purpose — the parse is already
    #: parallel inside itself, and oversubscribing cores makes a 50-page
    #: document slower, not faster.
    worker_parse_threads: int = 4

    #: Longest edge of a generated page thumbnail, in pixels.
    worker_thumbnail_max_edge: int = 1600

    #: Identity in the Redis consumer group.
    #:
    #: It must be stable across restarts of *this* process and distinct from
    #: every other replica: a restarted worker reclaims its own half-finished
    #: deliveries by name, and two replicas sharing a name would each think the
    #: other's in-flight jobs were their own to recover. The container
    #: hostname is both, which is why it is the default.
    worker_name: str | None = None

    @field_validator(
        "worker_concurrency",
        "worker_job_timeout_seconds",
        "worker_max_attempts",
        "worker_parse_threads",
        "worker_thumbnail_max_edge",
        "embedding_dimensions",
        "embedding_batch_size",
        "model_max_retries",
        "model_breaker_failures",
        "chunk_target_tokens",
        "chunk_min_tokens",
        "chunk_max_tokens",
    )
    @classmethod
    def _check_positive_int(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("must be greater than zero")
        return value

    @field_validator(
        "worker_retry_base_seconds",
        "model_timeout_seconds",
        "embedding_timeout_seconds",
        "model_breaker_cooldown_seconds",
    )
    @classmethod
    def _check_positive_float(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("must be greater than zero")
        return value

    @field_validator(
        "text_coverage_threshold",
        "ocr_fallback_threshold",
        "ocr_low_confidence_threshold",
    )
    @classmethod
    def _check_fraction(cls, value: float) -> float:
        if not 0.0 <= value <= 1.0:
            raise ValueError("must be a fraction between 0 and 1")
        return value

    @field_validator("ocr_dpi")
    @classmethod
    def _check_dpi(cls, value: float) -> float:
        # The floor is where recognition starts failing rather than degrading;
        # the ceiling is where a single page stops fitting in a worker's memory.
        # Both are wide enough that hitting one means a typo — a DPI of 30 or of
        # 3000 — rather than a deliberate choice.
        if not 72.0 <= value <= 1200.0:
            raise ValueError("must be between 72 and 1200 dots per inch")
        return value

    @field_validator("ocr_languages")
    @classmethod
    def _check_languages(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must name at least one language, e.g. eng")
        return value

    @field_validator("chunk_overlap_ratio")
    @classmethod
    def _check_overlap(cls, value: float) -> float:
        # At a half, every chunk repeats half of its neighbour and the index
        # doubles in size for nothing; the ceiling is there to catch a ratio
        # typed as a percentage.
        if not 0.0 <= value <= 0.5:
            raise ValueError("must be a fraction between 0 and 0.5")
        return value

    def provider_for(self, role: ModelRole) -> LlmProvider:
        """Which provider serves a role: its own variable, or ``llm_provider``.

        The fallback is what keeps the common case one variable. It is also why
        the offline check has to walk all four roles rather than reading
        ``llm_provider`` alone — a deployment with ``LLM_PROVIDER=ollama`` and
        ``CHAT_PROVIDER=openai`` is a cloud deployment, whatever the fallback
        says.
        """
        override = {
            "chat": self.chat_provider,
            "embedding": self.embedding_provider,
            "rerank": self.rerank_provider,
            "vision": self.vision_provider,
        }[role]
        return override or self.llm_provider

    def model_for(self, role: ModelRole) -> str | None:
        """The model configured for a role, or ``None`` to take the default."""
        return {
            "chat": self.llm_chat_model,
            "embedding": self.embedding_model,
            "rerank": self.rerank_model,
            "vision": self.vision_model,
        }[role]

    @model_validator(mode="after")
    def _check_offline_mode(self) -> Self:
        """Fail the process when offline mode and a cloud provider disagree.

        Loudly, at boot, naming what the operator actually wrote. The
        alternative is a deployment installed *because* document text cannot
        leave the building quietly sending its first document to the internet,
        which is the one failure this project cannot absorb.
        """
        if not self.offline_mode:
            return self

        offending = [
            (ROLE_PROVIDER_VARIABLE[role], self.provider_for(role))
            for role in MODEL_ROLES
            if self.provider_for(role) in CLOUD_PROVIDERS
        ]
        if offending:
            # Name only variables that were set. Every role inherits
            # ``llm_provider``, so listing all four would report three unset
            # variables as the cause of a mistake in one that is set.
            explicit = [
                f"{name}={provider}"
                for name, provider in offending
                if getattr(self, name.lower()) is not None
            ]
            named = ", ".join(explicit) or f"LLM_PROVIDER={self.llm_provider}"
            raise ValueError(
                f"OFFLINE_MODE: is true, but a cloud provider is configured ({named}). "
                "Offline mode "
                "means a document's text cannot leave this deployment, so every role "
                f"must name one of {' or '.join(LOCAL_PROVIDERS)}. Refusing to start "
                "rather than quietly sending the first document to the internet."
            )

        if self.llm_base_url is not None and not is_local_endpoint(self.llm_base_url):
            raise ValueError(
                f"LLM_BASE_URL: points at {urlparse(self.llm_base_url).hostname}, "
                "which is not a local "
                "address, and OFFLINE_MODE is true. An OpenAI-compatible proxy is still "
                "the internet if it is hosted on it."
            )

        return self

    @model_validator(mode="after")
    def _check_chunk_band(self) -> Self:
        if self.chunk_min_tokens > self.chunk_target_tokens:
            raise ValueError(
                f"CHUNK_MIN_TOKENS: is {self.chunk_min_tokens}, above "
                f"CHUNK_TARGET_TOKENS={self.chunk_target_tokens}"
            )
        if self.chunk_max_tokens < self.chunk_target_tokens:
            raise ValueError(
                f"CHUNK_MAX_TOKENS: is {self.chunk_max_tokens}, below "
                f"CHUNK_TARGET_TOKENS={self.chunk_target_tokens}"
            )
        return self

    @model_validator(mode="after")
    def _check_embedding_provider(self) -> Self:
        provider = self.provider_for("embedding")
        if provider in PROVIDERS_WITHOUT_EMBEDDINGS and self.embedding_model is not None:
            raise ValueError(
                f"EMBEDDING_PROVIDER: is {provider}, which has no embedding endpoint "
                "this router can "
                "address. Set EMBEDDING_PROVIDER to one that does — openai, mistral, "
                "ollama or vllm — and leave the chat role where it is."
            )
        return self

    def consumer_name(self) -> str:
        """This process's name inside the consumer group."""
        return self.worker_name or socket.gethostname()

    @model_validator(mode="before")
    @classmethod
    def _blank_is_unset(cls, values: Any) -> Any:
        """Treat ``LLM_API_KEY=`` as absent, not as the empty string.

        ``.env.example`` ships several variables with no value, so an empty
        string has to mean "not configured" — otherwise a required variable
        blanked out would pass validation and fail much later.
        """
        if not isinstance(values, dict):
            return values
        return {
            key: value
            for key, value in values.items()
            if not (isinstance(value, str) and value.strip() == "")
        }

    @field_validator("app_url")
    @classmethod
    def _check_app_url(cls, value: str) -> str:
        value = value.strip()
        _require_url(value, ("http", "https"), "http(s)")
        if value.endswith("/"):
            raise ValueError("must not have a trailing slash")
        return value

    @field_validator("database_url")
    @classmethod
    def _check_database_url(cls, value: str) -> str:
        return _require_url(value.strip(), ("postgres", "postgresql"), "postgres://")

    @field_validator("redis_url")
    @classmethod
    def _check_redis_url(cls, value: str) -> str:
        return _require_url(value.strip(), ("redis", "rediss"), "redis://")

    @field_validator("s3_endpoint", "ollama_base_url")
    @classmethod
    def _check_http_url(cls, value: str) -> str:
        return _require_url(value.strip(), ("http", "https"), "http(s)")

    @field_validator("s3_bucket", "s3_access_key_id", "s3_secret_access_key", "s3_region")
    @classmethod
    def _check_non_empty(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be empty")
        return value

    @field_validator("max_upload_bytes")
    @classmethod
    def _check_positive(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("must be a positive number of bytes")
        return value

    @field_validator("max_pages")
    @classmethod
    def _check_non_negative(cls, value: int) -> int:
        if value < 0:
            raise ValueError("must be zero (unlimited) or a positive page count")
        return value


def _describe(error: ValidationError) -> list[str]:
    """Turn pydantic's locations back into the variable names an operator typed."""
    issues: list[str] = []
    for detail in error.errors():
        location = detail["loc"]
        message = detail["msg"].removeprefix("Value error, ")

        if not location:
            # A cross-field rule: pydantic gives a whole-model validator no
            # field location, so the validator names the variable itself and
            # the message is already in the right shape.
            issues.append(message)
            continue

        name = str(location[0]).upper()
        if detail["type"] == "missing":
            issues.append(f"{name}: is required but was not set")
        else:
            issues.append(f"{name}: {message}")
    return issues


def load_settings(**overrides: Any) -> Settings:
    """Validate the environment, raising :class:`EnvValidationError` on any problem."""
    overrides.setdefault("_env_file", _find_env_file())
    try:
        return Settings(**overrides)
    except ValidationError as error:
        issues = _describe(error)
        message = "\n".join(
            [
                "Invalid environment configuration:",
                *(f"  - {issue}" for issue in issues),
                "",
                "Copy .env.example to .env and fill in the values it documents.",
            ]
        )
        raise EnvValidationError(message, issues) from None
