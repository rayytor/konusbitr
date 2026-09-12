"""Turning a stream entry into a job, or into a reason it is not one.

Decoding is where a contract breach first becomes visible, so it has to fail in
a way that says *what* broke. The three cases below — not JSON, wrong envelope
version, right version but wrong shape — each produce a different code,
because they call for three different responses from whoever is paged.

All three are terminal. That is the point: a payload that fails validation
fails it identically on every redelivery, and a queue that keeps retrying one
turns a single bad message into an outage.
"""

from __future__ import annotations

import json

import pytest

from konusbitr_worker.contracts import JOBS_STREAM_FIELD, JobErrorCode
from konusbitr_worker.queue import Delivery, UndecodableEntry, decode
from tests.factories import make_payload


def entry(payload: object) -> dict[str, str]:
    return {JOBS_STREAM_FIELD: json.dumps(payload)}


def test_a_valid_entry_decodes_to_a_delivery() -> None:
    payload = make_payload()
    result = decode("1-0", entry(json.loads(payload.model_dump_json())))

    assert isinstance(result, Delivery)
    assert result.entry_id == "1-0"
    assert result.payload.documentId == payload.documentId


def test_an_entry_with_no_payload_field_is_undecodable() -> None:
    result = decode("1-0", {"something-else": "{}"})

    assert isinstance(result, UndecodableEntry)
    assert result.failure.code is JobErrorCode.invalid_payload


def test_an_entry_that_is_not_json_is_undecodable() -> None:
    result = decode("1-0", {JOBS_STREAM_FIELD: "{not json"})

    assert isinstance(result, UndecodableEntry)
    assert result.failure.code is JobErrorCode.invalid_payload
    assert result.failure.retryable is False


@pytest.mark.parametrize("version", [0, 2, None, "1"])
def test_a_foreign_envelope_version_is_reported_as_such(version: object) -> None:
    """Checked before the model, so the message says the useful thing.

    A worker older than the app that enqueued the job should say exactly that,
    not produce a list of fields that appear to have moved.
    """
    document = json.loads(make_payload().model_dump_json())
    document["v"] = version

    result = decode("1-0", entry(document))

    assert isinstance(result, UndecodableEntry)
    assert result.failure.code is JobErrorCode.unsupported_version
    assert "this worker is older" in result.failure.message


def test_a_missing_field_names_the_field() -> None:
    document = json.loads(make_payload().model_dump_json())
    del document["storageKey"]

    result = decode("1-0", entry(document))

    assert isinstance(result, UndecodableEntry)
    assert result.failure.code is JobErrorCode.invalid_payload
    assert "storageKey" in result.failure.message


def test_the_raw_entry_is_kept_so_it_can_be_dead_lettered_verbatim() -> None:
    """An operator has to be able to see what actually arrived.

    A re-serialised approximation of a payload that failed to parse is worse
    than useless for working out which side is wrong.
    """
    raw = '{"v": 1, "jobId": "job_1"}'
    result = decode("1-0", {JOBS_STREAM_FIELD: raw})

    assert isinstance(result, UndecodableEntry)
    assert result.raw == raw
