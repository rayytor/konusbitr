"""The heartbeat the container healthcheck reads."""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from konusbitr_worker import health


@pytest.fixture(autouse=True)
def heartbeat_in_tmp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "nested" / "worker.heartbeat"
    monkeypatch.setenv("KONUSBITR_WORKER_HEARTBEAT", str(path))
    return path


def test_absent_heartbeat_is_not_alive() -> None:
    assert health.is_alive() is False
    assert health.main() == 1


def test_touching_the_heartbeat_creates_its_directory() -> None:
    health.touch_heartbeat()

    assert health.heartbeat_path().is_file()
    assert health.is_alive() is True
    assert health.main() == 0


def test_a_stale_heartbeat_is_not_alive() -> None:
    health.touch_heartbeat()
    stale = time.time() - (health.DEFAULT_MAX_AGE_SECONDS + 5)
    os.utime(health.heartbeat_path(), (stale, stale))

    assert health.is_alive() is False
