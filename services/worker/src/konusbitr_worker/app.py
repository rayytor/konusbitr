"""The worker's HTTP surface: two probes and nothing else.

The worker is a queue consumer, not a service anyone calls. It listens on HTTP
only so that Compose, Kubernetes and an operator with `curl` can all ask the
same two questions, and the two questions are genuinely different:

``/health`` — *is this process still working?* Liveness. It fails when the job
loop has stopped turning, which is the failure a bare "the process exists"
check cannot see: a worker wedged on a dead Redis connection is running and
useless, and a restart is the correct response.

``/ready`` — *can this process do its job right now?* Readiness. It touches
Postgres, Redis and object storage. It fails while a dependency is down, and a
restart would not help, so nothing should restart on it.

Conflating the two is how a stack ends up in a restart loop because the
database was briefly slow.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from konusbitr_worker import __version__
from konusbitr_worker.db import Database
from konusbitr_worker.health import is_alive, touch_heartbeat
from konusbitr_worker.log import configure_logging, get_logger
from konusbitr_worker.queue import JobQueue
from konusbitr_worker.runtime import WorkerRuntime
from konusbitr_worker.settings import Settings, load_settings

__all__ = ["create_app"]

logger = get_logger("konusbitr.worker.app")

#: The loop writes the heartbeat this often; `/health` allows several misses
#: before it calls the process dead, so a slow machine is not restarted.
HEARTBEAT_INTERVAL_SECONDS = 5.0

#: A probe that hangs is a probe that fails; none of these are worth waiting on.
PROBE_TIMEOUT_SECONDS = 5.0


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings or load_settings()
    configure_logging("DEBUG" if resolved.node_env == "development" else "INFO")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        queue = JobQueue.connect(resolved.redis_url, consumer=resolved.consumer_name())
        database = await Database.connect(resolved.database_url)
        runtime = WorkerRuntime(settings=resolved, queue=queue, database=database)

        app.state.settings = resolved
        app.state.queue = queue
        app.state.database = database
        app.state.runtime = runtime

        await runtime.start()
        heartbeat = asyncio.create_task(_heartbeat(), name="konusbitr-heartbeat")

        logger.info(
            "konusbitr-worker ready",
            extra={"version": __version__, "offline": resolved.offline_mode},
        )

        try:
            yield
        finally:
            heartbeat.cancel()
            await runtime.stop()
            await database.close()
            await queue.close()

    app = FastAPI(
        title="Konusbitr worker",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.get("/health")
    async def health() -> JSONResponse:
        runtime: WorkerRuntime = app.state.runtime
        queue: JobQueue = app.state.queue

        # Both halves of "the loop is turning": the runtime says its tasks are
        # alive, and the heartbeat says the event loop is actually scheduling
        # them. A process wedged inside a blocking call satisfies the first and
        # not the second, and it is the one a restart fixes.
        checks: dict[str, Any] = {"loop": runtime.running and is_alive()}
        checks["redis"] = await _probe(queue.ping())

        # Model availability is reported, never required: the pipeline does not
        # call a model until Phase 08, and an unreachable Ollama must not make
        # a worker that parses documents perfectly well look broken.
        models = await _model_availability(resolved)

        ok = bool(checks["loop"]) and checks["redis"] is True
        body = {
            "ok": ok,
            "version": __version__,
            "checks": checks,
            "models": models,
            "worker": await runtime.snapshot(),
        }
        return JSONResponse(body, status_code=200 if ok else 503)

    @app.get("/ready")
    async def ready() -> JSONResponse:
        queue: JobQueue = app.state.queue
        database: Database = app.state.database

        checks = {
            "postgres": await _probe(database.ping()),
            "redis": await _probe(queue.ping()),
            "storage": await _probe(_reach_storage(resolved)),
        }
        ok = all(value is True for value in checks.values())
        return JSONResponse(
            {"ok": ok, "version": __version__, "checks": checks},
            status_code=200 if ok else 503,
        )

    return app


async def _heartbeat() -> None:
    """Keep the on-disk liveness marker fresh while the loop is turning."""
    while True:
        touch_heartbeat()
        await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)


async def _probe(awaitable: Any) -> bool | str:
    """Run a check, returning `True` or a short reason it failed.

    The reason is the exception's type and message, which is enough for an
    operator reading `curl /ready` and never contains anything from a document
    — the probes do not touch one.
    """
    try:
        await asyncio.wait_for(awaitable, timeout=PROBE_TIMEOUT_SECONDS)
    except Exception as error:
        return f"{type(error).__name__}: {error}"
    return True


async def _reach_storage(settings: Settings) -> None:
    """Confirm the object store answers.

    A bare HTTP request, not a signed one: any response at all — including the
    403 that an anonymous request to S3 earns — proves the endpoint is up and
    routable, which is the question readiness asks. Whether the *credentials*
    work is a different question, and Phase 07 answers it the only honest way
    there is, by fetching a real object.
    """
    async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_SECONDS) as client:
        await client.get(settings.s3_endpoint)


async def _model_availability(settings: Settings) -> dict[str, Any]:
    """What the router would be able to reach. Informational until Phase 08."""
    if settings.offline_mode:
        return {"mode": "offline", "provider": settings.llm_provider}
    return {"mode": "online", "provider": settings.llm_provider}
