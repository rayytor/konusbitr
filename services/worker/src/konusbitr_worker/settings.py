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
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import ValidationError, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

__all__ = [
    "EnvValidationError",
    "Settings",
    "load_settings",
]

NodeEnv = Literal["development", "test", "production"]
LlmProvider = Literal["openai", "anthropic", "google", "mistral", "ollama", "vllm"]
CreditsMode = Literal["unlimited", "metered"]


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

    llm_provider: LlmProvider = "openai"
    llm_api_key: str | None = None
    llm_chat_model: str | None = None
    embedding_model: str | None = None
    ollama_base_url: str = "http://localhost:11434"
    offline_mode: bool = False

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
    )
    @classmethod
    def _check_positive_int(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("must be greater than zero")
        return value

    @field_validator("worker_retry_base_seconds")
    @classmethod
    def _check_positive_float(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("must be greater than zero")
        return value

    @field_validator("text_coverage_threshold")
    @classmethod
    def _check_fraction(cls, value: float) -> float:
        if not 0.0 <= value <= 1.0:
            raise ValueError("must be a fraction between 0 and 1")
        return value

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
        name = str(location[0]).upper() if location else "(root)"
        if detail["type"] == "missing":
            issues.append(f"{name}: is required but was not set")
        else:
            message = detail["msg"]
            issues.append(f"{name}: {message.removeprefix('Value error, ')}")
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
