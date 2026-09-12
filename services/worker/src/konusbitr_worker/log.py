"""Structured JSON logging.

Every line the worker writes is one JSON object, and every line emitted while a
job is being handled carries ``job_id``, ``doc_id`` and ``org_id``. That is not
a nicety: the pipeline is concurrent, so without those three fields the log of a
busy worker is several interleaved stories with no way to tell them apart, and
the first question anyone asks about a stuck document is "what happened to *this
one*".

The three fields ride on a :class:`contextvars.ContextVar` rather than being
passed to every call, because an ``asyncio`` task inherits the context it was
created in — so code deep in the pipeline logs with the right job attached
without knowing a job exists.

Document text never reaches here. The whole document is untrusted input, and a
log line is read by an operator, shipped to an aggregator and, in Phase 12, to
error reporting.
"""

from __future__ import annotations

import contextvars
import json
import logging
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

__all__ = ["configure_logging", "get_logger", "job_context"]

# `None` rather than `{}` as the default: a mutable default on a ContextVar is
# shared by every context that never sets one, which is exactly the bug this
# module exists to avoid.
_JOB_CONTEXT: contextvars.ContextVar[dict[str, str] | None] = contextvars.ContextVar(
    "konusbitr_job_context", default=None
)

#: Attributes `logging` puts on every record. Anything else was passed as
#: `extra=` by us and belongs in the JSON object.
_STANDARD_ATTRIBUTES = frozenset(
    logging.LogRecord("", 0, "", 0, "", None, None).__dict__
) | frozenset({"message", "asctime", "taskName"})


class JsonFormatter(logging.Formatter):
    """Render a record as a single-line JSON object."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }

        payload.update(_JOB_CONTEXT.get() or {})

        for key, value in record.__dict__.items():
            if (
                key not in _STANDARD_ATTRIBUTES
                and key not in _DROPPED_ATTRIBUTES
                and not key.startswith("_")
            ):
                payload[key] = value

        if record.exc_info:
            # The type and message, never the document that provoked them.
            exc_type, exc_value, _ = record.exc_info
            payload["error_type"] = getattr(exc_type, "__name__", str(exc_type))
            payload["error"] = str(exc_value)

        return json.dumps(payload, default=str, ensure_ascii=False)


#: Libraries that are interesting only when they go wrong.
#:
#: `httpx` and `httpcore` log a dozen lines per request at DEBUG and the
#: readiness probe makes one every ten seconds; `redis` reports, on every new
#: connection, that a Redis 8 feature is missing from the Redis 7 the stack
#: ships. Neither is wrong, and together they are how a development stack ends
#: up with the worker's own log buried under connection bookkeeping. They keep
#: their warnings, which is the part anyone reads.
_QUIET_LIBRARIES = ("httpx", "httpcore", "redis", "asyncio", "urllib3", "botocore", "asyncpg")

#: Uvicorn attaches an ANSI-coloured copy of its own message under this key.
#: One message per line is the whole point of the format.
_DROPPED_ATTRIBUTES = frozenset({"color_message"})


def configure_logging(level: str = "INFO") -> None:
    """Send every logger through one JSON handler on stdout.

    Uvicorn installs its own handlers when it starts, so this replaces them
    afterwards as well — a stack whose access log is JSON and whose worker log
    is not is a stack nobody can grep.
    """
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers = []
        logger.propagate = True

    for name in _QUIET_LIBRARIES:
        logging.getLogger(name).setLevel(logging.WARNING)


def get_logger(name: str = "konusbitr.worker") -> logging.Logger:
    return logging.getLogger(name)


@contextmanager
def job_context(*, job_id: str, doc_id: str, org_id: str) -> Iterator[None]:
    """Attach a job's identifiers to every line logged inside the block."""
    token = _JOB_CONTEXT.set({"job_id": job_id, "doc_id": doc_id, "org_id": org_id})
    try:
        yield
    finally:
        _JOB_CONTEXT.reset(token)
