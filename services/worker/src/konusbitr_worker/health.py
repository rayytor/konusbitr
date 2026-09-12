"""Liveness, from both ends.

Two things live here. The **heartbeat** is a file the running worker touches
every few seconds; it is the only evidence that distinguishes a process that is
looping from one that exists. And the **probe** is what a container healthcheck
runs: it asks the worker's own ``/health`` endpoint, which reports the
heartbeat alongside queue connectivity, so one command covers "the process is
alive" and "it can still reach Redis".

Run as a module, the probe exits 0 when the worker is healthy and 1 when it is
not, which is exactly what ``HEALTHCHECK`` wants::

    python -m konusbitr_worker.health
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

__all__ = [
    "DEFAULT_MAX_AGE_SECONDS",
    "heartbeat_path",
    "is_alive",
    "probe",
    "touch_heartbeat",
]

#: Generous next to the loop's own interval, so a slow machine is not called dead.
DEFAULT_MAX_AGE_SECONDS = 30.0

_DEFAULT_PATH = "/tmp/konusbitr-worker.heartbeat"  # the image overrides this

_PROBE_TIMEOUT_SECONDS = 5.0


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


def health_url() -> str:
    """The endpoint the probe calls.

    Read from the environment rather than from :mod:`konusbitr_worker.settings`
    on purpose: a healthcheck must not fail because some *unrelated* variable
    is missing, or a container with a bad ``S3_BUCKET`` would report itself
    unhealthy instead of reporting the real error in its logs.
    """
    port = os.environ.get("WORKER_PORT", "8081")
    return os.environ.get("KONUSBITR_WORKER_HEALTH_URL", f"http://127.0.0.1:{port}/health")


def probe() -> tuple[bool, str]:
    """Ask the worker how it is. Returns ``(healthy, detail)``."""
    url = health_url()
    try:
        with urllib.request.urlopen(url, timeout=_PROBE_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
            return bool(body.get("ok")), json.dumps(body.get("checks", {}))
    except urllib.error.HTTPError as error:
        return False, f"{url} returned {error.code}"
    except Exception as error:
        return False, f"{url} is not answering: {type(error).__name__}: {error}"


def main() -> int:
    healthy, detail = probe()
    if healthy:
        return 0
    print(f"worker unhealthy: {detail}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
