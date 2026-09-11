"""The placeholder run loop: it must heartbeat, and it must stop when asked."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from konusbitr_worker import __main__ as entrypoint
from konusbitr_worker import health
from konusbitr_worker.settings import Settings

VALID = {
    "app_url": "http://localhost:3000",
    "database_url": "postgresql://konusbitr:konusbitr@localhost:5432/konusbitr",
    "redis_url": "redis://localhost:6379",
    "s3_endpoint": "http://localhost:9000",
    "s3_bucket": "konusbitr",
    "s3_access_key_id": "konusbitr",
    "s3_secret_access_key": "konusbitr-dev-secret",
}


@pytest.fixture(autouse=True)
def heartbeat_in_tmp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KONUSBITR_WORKER_HEARTBEAT", str(tmp_path / "worker.heartbeat"))


def test_run_heartbeats_then_returns_when_stopped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(entrypoint, "HEARTBEAT_INTERVAL_SECONDS", 0.01)
    settings = Settings(_env_file=None, **VALID)

    stop = threading.Event()
    thread = threading.Thread(target=entrypoint.run, args=(settings, stop))
    thread.start()
    try:
        assert health.is_alive() or _wait_for_heartbeat()
    finally:
        stop.set()
        thread.join(timeout=5)

    assert not thread.is_alive()


def _wait_for_heartbeat(timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if health.is_alive():
            return True
        time.sleep(0.05)
    return False


def test_main_exits_nonzero_on_a_bad_environment(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for key in ("APP_URL", "DATABASE_URL", "REDIS_URL"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("KONUSBITR_ENV_FILE", "/nonexistent/.env")

    assert entrypoint.main() == 1
    assert "DATABASE_URL: is required but was not set" in capsys.readouterr().err
