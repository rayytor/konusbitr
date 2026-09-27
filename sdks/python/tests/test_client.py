"""The SDK's own behaviour, against a transport the test controls.

What is under test here is the half that is *not* generated: the URL a call
goes to, how a failure becomes a typed exception, when a request is retried and
when it is not, and how a job is waited on. All of that is written by hand, so
all of it needs asserting.

`httpx.MockTransport` rather than a live server: a running instance would make
these tests about the API again, slowly, and the API has its own suite.
"""

from __future__ import annotations

import json

import httpx
import pytest

from konusbitr import AsyncKonusbitr, JobFailedError, Konusbitr, KonusbitrError, RateLimitError

BASE = "https://konusbitr.example.com"
KEY = "kb_test_key"


def client_with(handler, **options) -> Konusbitr:
    return Konusbitr(
        base_url=BASE,
        api_key=KEY,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        **options,
    )


def json_response(status: int, body: object, headers: dict[str, str] | None = None):
    return httpx.Response(
        status,
        content=json.dumps(body),
        headers={"content-type": "application/json", **(headers or {})},
    )


# ── Routing ──────────────────────────────────────────────────────────────────


def test_v2_operations_go_under_v2():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return json_response(200, {"docId": "doc_1"})

    client = client_with(handler)
    client.parse(docId="doc_1")
    client.ask(docId="doc_1", question="?")

    assert seen == [f"{BASE}/v2/parse", f"{BASE}/v2/ask"]


def test_legacy_operations_go_under_v1():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return json_response(200, {"content": "", "references": []})

    client = client_with(handler)
    client.chat_with_pdf(docId="doc_1", question="?")

    assert seen == [f"{BASE}/v1/chat-with-pdf"]


def test_path_parameters_are_substituted():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return json_response(200, {"docId": "doc_1"})

    client = client_with(handler)
    client.get_document("doc_abc")
    client.get_job("ajob_xyz")

    assert seen == [f"{BASE}/v2/documents/doc_abc", f"{BASE}/v2/jobs/ajob_xyz"]


def test_the_api_key_is_sent_on_every_request():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-api-key"] == KEY
        return json_response(200, {})

    client_with(handler).get_document("doc_1")


def test_a_trailing_slash_on_the_base_url_does_not_double_up():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return json_response(200, {})

    Konusbitr(
        base_url=f"{BASE}/",
        api_key=KEY,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    ).get_document("doc_1")

    assert seen == [f"{BASE}/v2/documents/doc_1"]


# ── Bodies ───────────────────────────────────────────────────────────────────


def test_a_json_body_is_sent_as_json():
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        assert request.headers["content-type"] == "application/json"
        return json_response(200, {})

    client_with(handler).parse(url="https://example.com/a.pdf", quality="advanced")
    assert captured == {"url": "https://example.com/a.pdf", "quality": "advanced"}


def test_a_file_switches_the_request_to_multipart(tmp_path):
    path = tmp_path / "doc.pdf"
    path.write_bytes(b"%PDF-1.7\n")

    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["content-type"].startswith("multipart/form-data")
        captured["body"] = request.content.decode("latin-1")
        return json_response(200, {})

    with path.open("rb") as handle:
        client_with(handler).parse(file=handle, llm=True, lang_list=["tr", "en"])

    # A form value has no way to be a list or a boolean, so those two are
    # encoded exactly as the API decodes them back.
    assert 'name="llm"' in captured["body"]
    assert "true" in captured["body"]
    assert '["tr", "en"]' in captured["body"]


# ── Errors ───────────────────────────────────────────────────────────────────


def test_an_error_envelope_becomes_a_typed_exception():
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            400,
            {
                "error": {
                    "code": "input_conflict",
                    "message": "Give exactly one of file, url or docId.",
                    "details": {"given": ["url", "docId"]},
                    "requestId": "req_abc",
                }
            },
            {"x-request-id": "req_abc"},
        )

    with pytest.raises(KonusbitrError) as raised:
        client_with(handler).parse(url="x", docId="y")

    error = raised.value
    assert error.code == "input_conflict"
    assert error.status == 400
    assert error.details == {"given": ["url", "docId"]}
    assert error.request_id == "req_abc"
    assert error.retryable is False


def test_a_429_carries_retry_after():
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            429,
            {"error": {"code": "rate_limited", "message": "Slow down.", "requestId": "req_1"}},
            {"retry-after": "7"},
        )

    with pytest.raises(RateLimitError) as raised:
        client_with(handler, max_retries=0).get_document("doc_1")

    assert raised.value.retry_after_seconds == 7
    assert raised.value.code == "rate_limited"


def test_a_failure_with_no_body_is_still_a_typed_error():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, content=b"<html>bad gateway</html>")

    with pytest.raises(KonusbitrError) as raised:
        client_with(handler, max_retries=0).get_document("doc_1")

    assert raised.value.status == 502
    assert raised.value.retryable is True


# ── Retries ──────────────────────────────────────────────────────────────────


def test_a_5xx_is_retried_and_then_succeeds():
    attempts = {"count": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        if attempts["count"] < 3:
            return json_response(
                503,
                {"error": {"code": "upstream_unavailable", "message": "x", "requestId": "r"}},
            )
        return json_response(200, {"docId": "doc_1"})

    assert client_with(handler).get_document("doc_1") == {"docId": "doc_1"}
    assert attempts["count"] == 3


def test_a_4xx_is_never_retried():
    attempts = {"count": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        return json_response(
            404, {"error": {"code": "not_found", "message": "x", "requestId": "r"}}
        )

    with pytest.raises(KonusbitrError):
        client_with(handler).get_document("doc_1")

    # Retrying a request that is wrong is a slower way to get the same answer.
    assert attempts["count"] == 1


def test_retries_are_bounded():
    attempts = {"count": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        return json_response(500, {"error": {"code": "internal", "message": "x", "requestId": "r"}})

    with pytest.raises(KonusbitrError):
        client_with(handler, max_retries=2).get_document("doc_1")

    assert attempts["count"] == 3


# ── Asynchronous operations ──────────────────────────────────────────────────


def test_start_sends_async_true():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return json_response(202, {"jobId": "ajob_1", "status": "pending"})

    client = client_with(handler)
    assert client.start("parse", docId="doc_1")["jobId"] == "ajob_1"
    assert seen == [f"{BASE}/v2/parse?async=true"]


def test_start_attaches_a_webhook_url():
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return json_response(202, {"jobId": "ajob_1"})

    client_with(handler).start("parse", docId="doc_1", webhook_url="https://hooks.example/x")
    assert captured["webhook_url"] == "https://hooks.example/x"


def test_wait_for_job_polls_until_it_succeeds():
    states = iter(
        [
            {"status": "pending", "progress": 0, "result": None},
            {"status": "running", "progress": 40, "result": None},
            {"status": "succeeded", "progress": 100, "result": {"docId": "doc_1"}},
        ]
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(200, next(states))

    result = client_with(handler).wait_for_job("ajob_1", interval=0)
    assert result == {"docId": "doc_1"}


def test_wait_for_job_raises_the_operation_s_own_error():
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            200,
            {
                "status": "failed",
                "progress": 100,
                "result": None,
                "error": {
                    "code": "needs_ocr",
                    "message": "That file is a scan.",
                    "requestId": "req_1",
                },
            },
        )

    with pytest.raises(JobFailedError) as raised:
        client_with(handler).wait_for_job("ajob_1", interval=0)

    assert raised.value.job_id == "ajob_1"
    assert raised.value.code == "needs_ocr"


def test_wait_for_job_gives_up_eventually():
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(200, {"status": "running", "progress": 1, "result": None})

    with pytest.raises(KonusbitrError) as raised:
        client_with(handler).wait_for_job("ajob_1", interval=0, timeout=0)

    assert raised.value.code == "timeout"


# ── The asynchronous client ──────────────────────────────────────────────────


async def test_the_async_client_behaves_the_same_way():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-api-key"] == KEY
        return json_response(200, {"docId": "doc_1", "pageCount": 3})

    async with AsyncKonusbitr(
        base_url=BASE,
        api_key=KEY,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    ) as client:
        assert (await client.parse(docId="doc_1"))["pageCount"] == 3


async def test_the_async_client_raises_the_same_typed_errors():
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            403,
            {"error": {"code": "missing_scope", "message": "x", "requestId": "r"}},
        )

    async with AsyncKonusbitr(
        base_url=BASE,
        api_key=KEY,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    ) as client:
        with pytest.raises(KonusbitrError) as raised:
            await client.parse(docId="doc_1")

    assert raised.value.code == "missing_scope"
