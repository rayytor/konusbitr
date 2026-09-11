"""Worker entrypoint.

Placeholder until **Phase 06**, which replaces the idle loop below with FastAPI
for health and control and arq for the job loop. What it does today is real and
load-bearing, though:

* it validates the environment and dies immediately, naming the variable, if
  anything is missing — the same promise the web app makes;
* it keeps a heartbeat so the container healthcheck means something;
* it exits cleanly on SIGTERM, so ``docker compose down`` is not a 10-second
  wait for a kill.

Nothing here touches Postgres, Redis or storage. The worker learns to talk to
those over the Redis job queue in Phase 06, and never through a shared ORM.
"""

from __future__ import annotations

import logging
import signal
import sys
import threading
from types import FrameType

from konusbitr_worker import __version__
from konusbitr_worker.health import touch_heartbeat
from konusbitr_worker.settings import EnvValidationError, Settings, load_settings

HEARTBEAT_INTERVAL_SECONDS = 5.0

logger = logging.getLogger("konusbitr.worker")


def _configure_logging(settings: Settings) -> None:
    logging.basicConfig(
        level=logging.DEBUG if settings.node_env == "development" else logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
    )


def run(settings: Settings, stop: threading.Event) -> None:
    """Hold the process open, heartbeating, until asked to stop."""
    logger.info(
        "konusbitr-worker %s ready (env=%s, offline=%s); job loop arrives in Phase 06",
        __version__,
        settings.node_env,
        settings.offline_mode,
    )
    while not stop.is_set():
        touch_heartbeat()
        stop.wait(HEARTBEAT_INTERVAL_SECONDS)
    logger.info("konusbitr-worker stopping")


def main() -> int:
    try:
        settings = load_settings()
    except EnvValidationError as error:
        # stderr, not the logger: logging is not configured yet, and this has to
        # be the last thing an operator sees in `docker compose logs worker`.
        print(f"\n{error}\n", file=sys.stderr)
        return 1

    _configure_logging(settings)

    stop = threading.Event()

    def handle(signum: int, _frame: FrameType | None) -> None:
        logger.info("received %s", signal.Signals(signum).name)
        stop.set()

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)

    # Written before the first sleep so the healthcheck's start period does not
    # have to cover a whole interval.
    touch_heartbeat()
    run(settings, stop)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
