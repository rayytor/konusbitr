"""Fixtures built on the doubles in :mod:`tests.factories`."""

from __future__ import annotations

import pytest

from konusbitr_worker.settings import Settings
from tests.factories import BASE_ENV, FakeQueue


@pytest.fixture
def settings() -> Settings:
    """Settings with every wait turned down, so the tests are instant."""
    return Settings(
        _env_file=None,
        worker_stub_stage_seconds=0.0,
        worker_retry_base_seconds=1.0,
        worker_max_attempts=3,
        worker_concurrency=2,
        **BASE_ENV,
    )


@pytest.fixture
def queue() -> FakeQueue:
    return FakeQueue()
