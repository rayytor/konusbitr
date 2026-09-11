"""Runtime configuration for the worker, validated once at process start.

This is the Python half of the environment contract. The TypeScript half lives
in ``packages/shared/src/env.ts`` and the two describe the same variables from
the same ``.env``; ``.env.example`` documents both.

Konusbitr fails loudly at boot rather than lazily at first use. A worker that
starts with an unset ``REDIS_URL`` and only notices when the first job arrives
has turned a one-line configuration mistake into an incident, so
:func:`load_settings` raises with every offending variable named.

Unlike the job payload models, which are generated from Zod in Phase 06, this
module is hand-written: it is configuration rather than a wire format, and it
must be importable before any code generation has run.
"""

from __future__ import annotations

import os
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

    llm_provider: LlmProvider = "openai"
    llm_api_key: str | None = None
    llm_chat_model: str | None = None
    embedding_model: str | None = None
    ollama_base_url: str = "http://localhost:11434"
    offline_mode: bool = False

    billing_enabled: bool = False
    credits_mode: CreditsMode = "unlimited"

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
