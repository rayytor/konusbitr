"""Structured logging.

Two properties matter and both were learned the hard way. Every line emitted
while a job is being handled carries `job_id`, `doc_id` and `org_id`, because
the pipeline is concurrent and without them the log of a busy worker is
several interleaved stories with no way to tell them apart. And the libraries
underneath are quiet: `httpx` logs a dozen DEBUG lines per request, the
readiness probe makes one every ten seconds, and a development stack ended up
with the worker's own log buried under connection bookkeeping.

These go through the real handler and read the real stdout rather than
inspecting `LogRecord`s, because the job identifiers are attached *while the
line is being formatted* — which is the same context the logging call was made
in, and is not the context a test that formats records afterwards would be in.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator

import pytest

from konusbitr_worker.log import configure_logging, get_logger, job_context


@pytest.fixture(autouse=True)
def restore_logging() -> Iterator[None]:
    """Put the root logger back, so one test's handler is not every test's."""
    root = logging.getLogger()
    handlers, level = root.handlers[:], root.level
    yield
    root.handlers, root.level = handlers, level


def lines(capsys: pytest.CaptureFixture[str]) -> list[dict[str, object]]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]


def test_a_line_is_one_json_object(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("INFO")
    get_logger("konusbitr.test").info("stage", extra={"stage": "ocr", "percent": 45})

    line = lines(capsys)[0]
    assert line["message"] == "stage"
    assert line["level"] == "info"
    assert line["logger"] == "konusbitr.test"
    assert line["stage"] == "ocr"
    assert line["percent"] == 45
    assert "ts" in line


def test_job_identifiers_ride_on_every_line_inside_the_context(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO")
    logger = get_logger("konusbitr.test")

    with job_context(job_id="job_1", doc_id="doc_1", org_id="org_1"):
        logger.info("inside")
    logger.info("outside")

    inside, outside = lines(capsys)
    assert (inside["job_id"], inside["doc_id"], inside["org_id"]) == ("job_1", "doc_1", "org_1")
    assert "job_id" not in outside


def test_an_exception_is_logged_by_type_and_message_only(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Never a multi-line traceback, which would break one-line-per-event.

    The message is kept because it is the useful part; nothing from a document
    ever reaches it, because every failure the pipeline raises carries a
    message written for a person.
    """
    configure_logging("INFO")

    try:
        raise ValueError("the parser gave up")
    except ValueError:
        get_logger("konusbitr.test").exception("job failed")

    captured = capsys.readouterr().out
    assert len(captured.strip().splitlines()) == 1

    line = json.loads(captured)
    assert line["error_type"] == "ValueError"
    assert line["error"] == "the parser gave up"


def test_chatty_libraries_are_quieted() -> None:
    configure_logging("DEBUG")

    assert logging.getLogger("httpx").level == logging.WARNING
    assert logging.getLogger("httpcore").level == logging.WARNING
    assert logging.getLogger("redis").level == logging.WARNING
    # Ours keeps whatever the root was set to.
    assert logging.getLogger().level == logging.DEBUG


def test_uvicorns_ansi_copy_of_its_own_message_is_dropped(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Uvicorn passes a coloured duplicate as `extra`; one message per line."""
    configure_logging("INFO")
    get_logger("uvicorn.error").info(
        "Uvicorn running", extra={"color_message": "\x1b[1mUvicorn running\x1b[0m"}
    )

    line = lines(capsys)[0]
    assert line["message"] == "Uvicorn running"
    assert "color_message" not in line
