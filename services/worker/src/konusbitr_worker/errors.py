"""Failure classification: what is worth trying again, and what never will be.

This is the distinction the whole retry policy turns on. A model that timed out
will probably answer next time; a PDF with a shredded cross-reference table will
not, however patiently it is re-read. Spending three attempts and two backoff
windows on the second kind delays every other document in the queue to reach a
conclusion that was available immediately — so a terminal failure is terminal on
the first attempt, and the document says so.

The codes themselves are part of the cross-runtime contract
(:data:`konusbitr_worker.contracts.JobErrorCode`), because a browser renders
them and Phase 13's public API returns them.
"""

from __future__ import annotations

import asyncio

from konusbitr_worker.contracts import JobErrorCode, is_retryable

__all__ = ["JobCancelled", "JobFailure", "classify_exception"]


class JobFailure(Exception):
    """A job that cannot be completed, with the reason in a form both runtimes know.

    The message is written for whoever uploaded the document: it says what is
    wrong and, where there is one, what to do instead. It never contains
    document text.
    """

    def __init__(self, code: JobErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    @property
    def retryable(self) -> bool:
        return is_retryable(self.code)

    def __str__(self) -> str:
        return f"{self.code.value}: {self.message}"


class JobCancelled(Exception):
    """A job that stopped because somebody asked it to.

    Deliberately not a :class:`JobFailure`. Every branch that handles a failure
    does something a cancellation must not: it spends a retry, or it
    dead-letters, or it marks a document `failed` in red and writes a line into
    the operator's failed-jobs view. A person stopping their own upload is none
    of those things, and the only way to keep the distinction honest is to make
    it impossible to reach the failure path by accident.

    It carries how far the job got, because that is what the reader is told:
    "stopped after 140 of 900 pages" is a true and useful sentence, and those
    140 pages remain indexed and answerable.
    """

    def __init__(self, *, pages_done: int = 0, pages_total: int | None = None) -> None:
        super().__init__("cancelled")
        self.pages_done = pages_done
        self.pages_total = pages_total

    @property
    def message(self) -> str:
        """What the person who cancelled it is shown."""
        if self.pages_total:
            return f"Stopped at your request, after {self.pages_done} of {self.pages_total} pages."
        return "Stopped at your request."


def classify_exception(error: BaseException) -> JobFailure:
    """Turn an arbitrary exception into a classified failure.

    Anything unrecognised is `internal` and therefore **retryable**, which is
    the deliberate default: an unexpected exception is much more often a blip in
    something the worker depends on than a permanent property of the document,
    and a retry that fails again costs one attempt, while wrongly marking a
    document permanently failed costs a person their upload.
    """
    if isinstance(error, JobFailure):
        return error

    if isinstance(error, asyncio.TimeoutError | TimeoutError):
        return JobFailure(JobErrorCode.timeout, "That took too long and was stopped.")

    if isinstance(error, asyncio.CancelledError):
        return JobFailure(JobErrorCode.cancelled, "That was interrupted before it finished.")

    if isinstance(error, MemoryError):
        return JobFailure(
            JobErrorCode.out_of_memory,
            "There was not enough memory to process that document.",
        )

    # Import lazily so this module stays importable without the drivers — the
    # contract tests exercise classification and should not need Postgres
    # bindings to do it.
    try:  # pragma: no cover - trivial import guard
        import asyncpg
    except ImportError:  # pragma: no cover
        asyncpg = None  # type: ignore[assignment]

    if asyncpg is not None and isinstance(error, asyncpg.PostgresError | asyncpg.InterfaceError):
        return JobFailure(JobErrorCode.database_unavailable, "The database refused that write.")

    if isinstance(error, ConnectionError | OSError):
        return JobFailure(
            JobErrorCode.storage_unavailable,
            "Something the worker depends on was unreachable.",
        )

    return JobFailure(JobErrorCode.internal, "Something went wrong processing that document.")
