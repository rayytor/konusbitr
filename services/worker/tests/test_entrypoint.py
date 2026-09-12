"""The entrypoint, and the promise it makes before it serves anything.

A worker that starts with an unset `REDIS_URL` and only notices when the first
job arrives has turned a one-line configuration mistake into an incident. So
the environment is validated before uvicorn is even constructed, and the
process dies naming the variable.
"""

from __future__ import annotations

from typing import Any

import pytest

from konusbitr_worker import __main__ as entrypoint
from tests.factories import BASE_ENV


def test_main_exits_nonzero_on_a_bad_environment(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for key in ("APP_URL", "DATABASE_URL", "REDIS_URL"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("KONUSBITR_ENV_FILE", "/nonexistent/.env")

    assert entrypoint.main() == 1
    assert "DATABASE_URL: is required but was not set" in capsys.readouterr().err


def test_main_serves_on_the_configured_host_and_port(monkeypatch: pytest.MonkeyPatch) -> None:
    """The one thing worth asserting about the happy path without a server.

    Actually starting uvicorn here would start the job loop, connect to Redis
    and Postgres, and turn a unit test into the integration test that already
    exists — so the server is stubbed and only its configuration is checked.
    """
    monkeypatch.setenv("KONUSBITR_ENV_FILE", "/nonexistent/.env")
    for key, value in BASE_ENV.items():
        monkeypatch.setenv(key.upper(), value)
    monkeypatch.setenv("WORKER_PORT", "8199")

    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(entrypoint, "create_app", lambda settings: settings)
    monkeypatch.setattr(entrypoint.uvicorn, "run", lambda _app, **kwargs: calls.append(kwargs))

    assert entrypoint.main() == 0
    assert calls[0]["port"] == 8199
    assert calls[0]["host"] == "0.0.0.0"
    # Uvicorn's own log config would put a second shape in a stream that is
    # otherwise one JSON object per line.
    assert calls[0]["log_config"] is None
    assert calls[0]["timeout_graceful_shutdown"] > 0
