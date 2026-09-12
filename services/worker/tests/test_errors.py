"""Retry classification.

The rule the whole policy rests on: a failure is retryable unless the *input*
is the problem. Getting this backwards in either direction is expensive — a
corrupt PDF that burns three attempts and two backoff windows delays every
other document in the queue, and a transient database blip that is called
terminal loses somebody's upload.
"""

from __future__ import annotations

import asyncio

import pytest

from konusbitr_worker.contracts import JobErrorCode
from konusbitr_worker.errors import JobFailure, classify_exception


@pytest.mark.parametrize(
    "code",
    [
        JobErrorCode.corrupt_document,
        JobErrorCode.encrypted_document,
        JobErrorCode.unsupported_format,
        JobErrorCode.too_many_pages,
        JobErrorCode.document_missing,
        JobErrorCode.content_hash_mismatch,
        JobErrorCode.invalid_payload,
        JobErrorCode.unknown_job_type,
        JobErrorCode.unsupported_version,
        JobErrorCode.object_missing,
    ],
)
def test_a_problem_with_the_input_is_terminal(code: JobErrorCode) -> None:
    assert JobFailure(code, "nope").retryable is False


@pytest.mark.parametrize(
    "code",
    [
        JobErrorCode.storage_unavailable,
        JobErrorCode.database_unavailable,
        JobErrorCode.model_unavailable,
        JobErrorCode.model_timeout,
        JobErrorCode.out_of_memory,
        JobErrorCode.timeout,
        JobErrorCode.internal,
    ],
)
def test_a_problem_around_the_input_is_retryable(code: JobErrorCode) -> None:
    assert JobFailure(code, "later").retryable is True


def test_classification_passes_an_already_classified_failure_through() -> None:
    original = JobFailure(JobErrorCode.encrypted_document, "password protected")

    assert classify_exception(original) is original


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (TimeoutError(), JobErrorCode.timeout),
        (asyncio.CancelledError(), JobErrorCode.cancelled),
        (MemoryError(), JobErrorCode.out_of_memory),
        (ConnectionResetError(), JobErrorCode.storage_unavailable),
        (OSError("no route to host"), JobErrorCode.storage_unavailable),
    ],
)
def test_known_exceptions_map_to_their_code(error: BaseException, expected: JobErrorCode) -> None:
    assert classify_exception(error).code is expected


def test_an_unrecognised_exception_is_internal_and_retryable() -> None:
    """The safe default, deliberately chosen.

    An unexpected exception is far more often something transient than a
    permanent property of the document, and a retry that fails again costs one
    attempt — while wrongly marking a document failed costs a person their
    upload.
    """
    failure = classify_exception(ValueError("something nobody anticipated"))

    assert failure.code is JobErrorCode.internal
    assert failure.retryable is True


def test_the_message_is_the_one_written_for_a_person() -> None:
    """The exception's own text never reaches the caller.

    An arbitrary exception message can carry anything the pipeline was holding
    when it was raised, and document text is untrusted input that must not end
    up in a UI or a log line.
    """
    failure = classify_exception(ValueError("page 4: 'CONFIDENTIAL — merger with…'"))

    assert "CONFIDENTIAL" not in failure.message
    assert failure.message == "Something went wrong processing that document."
