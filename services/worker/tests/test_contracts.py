"""The cross-runtime contract, from the Python side.

`contracts.py` is generated from the Zod schemas in `packages/shared` and CI
fails on any diff, so nothing here needs to check that the generator ran. What
it does check is the thing a generator cannot: that a payload written by the
*TypeScript* side — with its camelCase keys, its ISO timestamp and its
envelope version — round-trips through the generated model, and that anything
which is not one of those is rejected loudly rather than half-accepted.

The fixture below is a literal copy of what `enqueueParseJob` writes. If the
two ever part company, this is where it shows up.
"""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from konusbitr_worker.contracts import (
    DEAD_LETTER_MAX_LENGTH,
    JOB_PAYLOAD_VERSION,
    JOBS_CONSUMER_GROUP,
    JOBS_DEAD_LETTER,
    JOBS_RETRY_ZSET,
    JOBS_STREAM,
    JOBS_STREAM_FIELD,
    STAGE_PERCENT,
    TERMINAL_JOB_ERROR_CODES,
    TERMINAL_JOB_STAGES,
    JobErrorCode,
    JobPayload,
    JobProgress,
    JobStage,
    JobType,
    ParseQuality,
    is_retryable,
    progress_channel,
)
from konusbitr_worker.db import STAGE_TO_STATUS

#: Byte-for-byte what `apps/web/src/lib/ingest/queue.ts` puts on the stream.
FROM_TYPESCRIPT = """
{
  "v": 1,
  "type": "parse",
  "attempt": 1,
  "enqueuedAt": "2026-09-12T09:41:03.512Z",
  "jobId": "job_clx9a1b2c3d4e5f6g7h8i9j0",
  "orgId": "org_clx0a1b2c3",
  "documentId": "doc_clx1a1b2c3",
  "storageKey": "orgs/org_clx0a1b2c3/documents/doc_clx1a1b2c3/original.pdf",
  "contentHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "settings": { "quality": "standard", "langList": ["en", "tr"], "llm": false }
}
"""


def test_a_payload_written_by_typescript_validates() -> None:
    payload = JobPayload.model_validate_json(FROM_TYPESCRIPT)

    assert payload.v == JOB_PAYLOAD_VERSION
    assert payload.type is JobType.parse
    assert payload.settings.quality is ParseQuality.standard
    # A plain list of strings, not a list of wrapper models: the worker passes
    # these straight to OCR, and `settings.langList[0].root` would be absurd.
    assert payload.settings.langList == ["en", "tr"]
    assert payload.attempt == 1
    assert payload.enqueuedAt.tzinfo is not None


def test_the_payload_round_trips_back_to_the_same_json() -> None:
    """A retry re-enqueues the payload, so serialising must be lossless."""
    payload = JobPayload.model_validate_json(FROM_TYPESCRIPT)
    again = JobPayload.model_validate_json(payload.model_dump_json())

    assert again == payload


def test_an_unknown_field_is_rejected() -> None:
    """`extra="forbid"` is deliberate: a field the worker silently ignored
    would be a contract change nobody noticed until it mattered."""
    document = json.loads(FROM_TYPESCRIPT)
    document["priority"] = "high"

    with pytest.raises(ValidationError):
        JobPayload.model_validate(document)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("contentHash", "not-a-digest"),
        ("contentHash", "A" * 64),  # uppercase hex is a different string
        ("attempt", 0),
        ("jobId", ""),
        ("type", "transcribe"),
        ("settings", {"quality": "instant", "langList": [], "llm": False}),
    ],
)
def test_malformed_fields_are_rejected(field: str, value: object) -> None:
    document = json.loads(FROM_TYPESCRIPT)
    document[field] = value

    with pytest.raises(ValidationError):
        JobPayload.model_validate(document)


def test_progress_serialises_the_way_the_browser_reads_it() -> None:
    progress = JobProgress(
        jobId="job_1",
        documentId="doc_1",
        stage=JobStage.ocr,
        percent=45,
        message="Recognising text",
        at="2026-09-12T09:41:03.512Z",
    )
    rendered = json.loads(progress.model_dump_json())

    assert rendered["stage"] == "ocr"
    assert rendered["percent"] == 45
    assert rendered["errorCode"] is None


def test_every_stage_has_a_percentage() -> None:
    assert set(STAGE_PERCENT) == set(JobStage)
    assert STAGE_PERCENT[JobStage.ready] == 100
    # Monotonic in declaration order, which is what lets the reporter clamp a
    # percentage without ever needing to move it backwards.
    percentages = [STAGE_PERCENT[stage] for stage in JobStage]
    assert percentages == sorted(percentages)


def test_the_transport_key_names_are_the_generated_ones() -> None:
    """Pinned here as well as generated, so a rename is a visible diff.

    These strings are the other half of the contract: the web app writes to
    them from TypeScript constants generated from the same source.
    """
    assert JOBS_STREAM == "konusbitr:jobs"
    assert JOBS_CONSUMER_GROUP == "konusbitr:workers"
    assert JOBS_RETRY_ZSET == "konusbitr:jobs:retry"
    assert JOBS_DEAD_LETTER == "konusbitr:jobs:dead"
    assert JOBS_STREAM_FIELD == "payload"
    assert DEAD_LETTER_MAX_LENGTH > 0
    assert progress_channel("doc_1") == "konusbitr:progress:doc_1"


def test_terminal_stages_and_codes_agree_with_is_retryable() -> None:
    assert frozenset({JobStage.ready, JobStage.failed, JobStage.cancelled}) == TERMINAL_JOB_STAGES

    for code in JobErrorCode:
        assert is_retryable(code) is (code not in TERMINAL_JOB_ERROR_CODES)


def test_every_stage_maps_to_a_document_status() -> None:
    """The worker's own half of the contract: a stage the database layer has no
    status for would raise a KeyError in the middle of a job, in production."""
    assert set(STAGE_TO_STATUS) == set(JobStage)
