"""Liveness signalling for the worker container.

The run loop touches a heartbeat file; the container healthcheck reads it. A
process that is "running" but has stopped looping — wedged on a dead Redis
connection, say — is then reported unhealthy rather than healthy, which is the
whole point of having a healthcheck at all.

Run as a module, this exits 0 when the heartbeat is fresh and 1 when it is not,
which is exactly what ``HEALTHCHECK`` wants::

    python -m konusbitr_worker.health
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

__all__ = ["DEFAULT_MAX_AGE_SECONDS", "heartbeat_path", "is_alive", "touch_heartbeat"]

#: Generous next to the loop's own interval, so a slow machine is not called dead.
DEFAULT_MAX_AGE_SECONDS = 30.0

_DEFAULT_PATH = "/tmp/konusbitr-worker.heartbeat"


def heartbeat_path() -> Path:
    """Where the heartbeat lives. The container image points this at a writable dir."""
    return Path(os.environ.get("KONUSBITR_WORKER_HEARTBEAT", _DEFAULT_PATH))


def touch_heartbeat() -> None:
    """Record that the loop is still going round."""
    path = heartbeat_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(time.time()), encoding="utf-8")


def is_alive(max_age_seconds: float = DEFAULT_MAX_AGE_SECONDS) -> bool:
    """True when the heartbeat exists and is younger than ``max_age_seconds``."""
    path = heartbeat_path()
    try:
        age = time.time() - path.stat().st_mtime
    except OSError:
        return False
    return age <= max_age_seconds


def main() -> int:
    if is_alive():
        return 0
    print(f"worker heartbeat missing or stale at {heartbeat_path()}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
