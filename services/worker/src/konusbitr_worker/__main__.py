"""Worker entrypoint: the job loop and the health endpoints, in one process.

One deployable rather than two, because they are two views of the same thing —
the probes exist to report on the loop, and a sidecar that reported on a
*different* process would be answering a question nobody asked.

The loop runs inside FastAPI's lifespan, so uvicorn's signal handling is the
shutdown path: SIGTERM stops the server, the lifespan tears the runtime down,
and the runtime waits for whatever is in flight. ``docker compose down`` is
therefore a clean stop rather than a ten-second wait for a kill.

The environment is validated before any of that, and the process dies naming
the offending variable — the same promise the web app makes, for the same
reason: a worker that starts with an unset ``REDIS_URL`` and only notices when
the first job arrives has turned a typo into an incident.
"""

from __future__ import annotations

import sys

import uvicorn

from konusbitr_worker.app import create_app
from konusbitr_worker.settings import EnvValidationError, load_settings


def main() -> int:
    try:
        settings = load_settings()
    except EnvValidationError as error:
        # stderr, not the logger: logging is not configured yet, and this has to
        # be the last thing an operator sees in `docker compose logs worker`.
        print(f"\n{error}\n", file=sys.stderr)
        return 1

    uvicorn.run(
        create_app(settings),
        host=settings.worker_host,
        port=settings.worker_port,
        # Logging is configured by `create_app` and formats every line as JSON;
        # letting uvicorn install its own would give the same stream two shapes.
        log_config=None,
        access_log=False,
        # The grace period a job gets to finish before the loop is abandoned.
        # Anything still running is left unacknowledged, which is precisely
        # where the restarted worker looks for it.
        timeout_graceful_shutdown=30,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
