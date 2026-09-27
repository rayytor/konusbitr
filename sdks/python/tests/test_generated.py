"""The generated module, against the specification it came from.

The point of generating is that the SDK cannot describe an endpoint the API does
not have, or miss one it does. `make generate-check` proves the committed file
matches the generator's output; this proves the generator's output matches the
document.
"""

from __future__ import annotations

import json
from pathlib import Path

from konusbitr._generated import API_VERSION, OPERATIONS

SPEC = Path(__file__).resolve().parents[3] / "docs" / "openapi.json"


def spec() -> dict:
    return json.loads(SPEC.read_text())


def test_every_operation_in_the_document_is_in_the_sdk():
    expected = {
        operation["operationId"]
        for methods in spec()["paths"].values()
        for operation in methods.values()
    }
    assert set(OPERATIONS) == expected


def test_every_operation_names_its_method_and_path():
    document = spec()
    for name, operation in OPERATIONS.items():
        methods = document["paths"][operation["path"]]
        declared = methods[operation["method"].lower()]
        assert declared["operationId"] == name


def test_the_api_version_matches_the_document():
    assert spec()["info"]["version"] == API_VERSION


def test_the_four_v2_endpoints_and_both_legacy_ones_are_present():
    assert {"parse", "extract", "split", "ask"} <= set(OPERATIONS)
    assert {"chatWithPdf", "chatWithAllPdfs"} <= set(OPERATIONS)


def test_the_long_running_endpoints_are_marked_as_supporting_async():
    for name in ("parse", "extract", "split", "ask"):
        assert OPERATIONS[name]["supports_async"] is True
    for name in ("getDocument", "getJob", "chatWithPdf"):
        assert OPERATIONS[name]["supports_async"] is False


def test_the_file_taking_endpoints_accept_multipart():
    for name in ("parse", "extract", "split", "ask"):
        assert OPERATIONS[name]["body"] == "json-or-multipart"
