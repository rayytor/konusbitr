"""The worker half of the environment contract.

These mirror `packages/shared/test/env.test.ts` deliberately: the two runtimes
read the same `.env`, so they have to agree on what is required, what defaults
to what, and what an operator is told when something is wrong.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from konusbitr_worker.settings import EnvValidationError, load_settings

VALID = {
    "NODE_ENV": "test",
    "APP_URL": "http://localhost:3000",
    "DATABASE_URL": "postgresql://konusbitr:konusbitr@localhost:5432/konusbitr",
    "REDIS_URL": "redis://localhost:6379",
    "S3_ENDPOINT": "http://localhost:9000",
    "S3_BUCKET": "konusbitr",
    "S3_ACCESS_KEY_ID": "konusbitr",
    "S3_SECRET_ACCESS_KEY": "konusbitr-dev-secret",
    "S3_FORCE_PATH_STYLE": "true",
}

REQUIRED = [
    "APP_URL",
    "DATABASE_URL",
    "REDIS_URL",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Isolate from the developer's own shell and from any `.env` on disk."""
    extras = [
        "LLM_PROVIDER",
        "OFFLINE_MODE",
        "BILLING_ENABLED",
        "CREDITS_MODE",
        "MAX_UPLOAD_BYTES",
        "MAX_PAGES",
        "ALLOW_GLOBAL_PARSE_CACHE",
    ]
    for key in [*VALID, *extras]:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("KONUSBITR_ENV_FILE", "/nonexistent/.env")


def load(env: dict[str, str], monkeypatch: pytest.MonkeyPatch):
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return load_settings(_env_file=None)


def test_accepts_the_documented_minimum(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = load(VALID, monkeypatch)

    assert settings.app_url == "http://localhost:3000"
    assert settings.s3_force_path_style is True
    assert settings.s3_region == "us-east-1"
    assert settings.llm_provider == "openai"
    assert settings.offline_mode is False
    # Phase 05's ingest limits share the same defaults as the Zod schema, and
    # the global parse cache is off unless an operator turns it on.
    assert settings.max_upload_bytes == 500 * 1024 * 1024
    assert settings.max_pages == 0
    assert settings.allow_global_parse_cache is False
    assert settings.billing_enabled is False
    assert settings.credits_mode == "unlimited"
    assert settings.ollama_base_url == "http://localhost:11434"
    assert settings.llm_api_key is None


@pytest.mark.parametrize("name", REQUIRED)
def test_missing_variable_is_named(name: str, monkeypatch: pytest.MonkeyPatch) -> None:
    env = {key: value for key, value in VALID.items() if key != name}

    with pytest.raises(EnvValidationError) as caught:
        load(env, monkeypatch)

    assert f"{name}: is required but was not set" in str(caught.value)


@pytest.mark.parametrize("name", REQUIRED)
def test_blank_variable_is_treated_as_missing(name: str, monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(EnvValidationError) as caught:
        load({**VALID, name: "   "}, monkeypatch)

    assert f"{name}: is required but was not set" in str(caught.value)


def test_reports_every_problem_at_once(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(EnvValidationError) as caught:
        load({**VALID, "DATABASE_URL": "mysql://nope", "REDIS_URL": "http://nope"}, monkeypatch)

    issues = caught.value.issues
    assert "DATABASE_URL: must be a valid postgres:// URL" in issues
    assert "REDIS_URL: must be a valid redis:// URL" in issues


def test_rejects_app_url_with_trailing_slash(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(EnvValidationError) as caught:
        load({**VALID, "APP_URL": "http://localhost:3000/"}, monkeypatch)

    assert "APP_URL: must not have a trailing slash" in str(caught.value)


def test_rejects_unknown_llm_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(EnvValidationError) as caught:
        load({**VALID, "LLM_PROVIDER": "cohere"}, monkeypatch)

    assert "LLM_PROVIDER" in str(caught.value)


def test_reads_booleans_the_way_a_dotenv_writes_them(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = load({**VALID, "OFFLINE_MODE": "true", "BILLING_ENABLED": "1"}, monkeypatch)

    assert settings.offline_mode is True
    assert settings.billing_enabled is True


def test_blank_optional_variable_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = load({**VALID, "LLM_API_KEY": "", "LLM_CHAT_MODEL": ""}, monkeypatch)

    assert settings.llm_api_key is None
    assert settings.llm_chat_model is None


def test_settings_are_immutable(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = load(VALID, monkeypatch)

    with pytest.raises(Exception):  # noqa: B017 - pydantic raises ValidationError
        settings.redis_url = "redis://elsewhere:6379"  # type: ignore[misc]


def test_env_file_is_resolved_at_call_time_not_import_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`KONUSBITR_ENV_FILE` must steer the lookup on every call.

    Resolving the `.env` once at import time silently pinned whichever file
    happened to exist then, so a developer with a real `.env` on disk got a
    different result from CI, which has none.
    """
    env_file = tmp_path / ".env"
    env_file.write_text("REDIS_URL=redis://from-the-env-file:6379\n", encoding="utf-8")
    monkeypatch.setenv("KONUSBITR_ENV_FILE", str(env_file))

    for key, value in VALID.items():
        if key != "REDIS_URL":
            monkeypatch.setenv(key, value)

    assert load_settings().redis_url == "redis://from-the-env-file:6379"

    monkeypatch.setenv("KONUSBITR_ENV_FILE", str(tmp_path / "nonexistent"))
    with pytest.raises(EnvValidationError) as caught:
        load_settings()
    assert "REDIS_URL: is required but was not set" in str(caught.value)


def test_reads_the_ingest_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = load(
        {
            **VALID,
            "MAX_UPLOAD_BYTES": "1048576",
            "MAX_PAGES": "200",
            "ALLOW_GLOBAL_PARSE_CACHE": "true",
        },
        monkeypatch,
    )

    assert settings.max_upload_bytes == 1048576
    assert settings.max_pages == 200
    assert settings.allow_global_parse_cache is True


@pytest.mark.parametrize(
    ("name", "value"),
    [("MAX_UPLOAD_BYTES", "0"), ("MAX_PAGES", "-1")],
)
def test_rejects_nonsensical_limits(name: str, value: str, monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(EnvValidationError) as raised:
        load({**VALID, name: value}, monkeypatch)

    assert any(issue.startswith(name) for issue in raised.value.issues)
