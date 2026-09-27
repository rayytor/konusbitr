"""The runtime half of the SDK, written by hand on purpose.

Everything an OpenAPI document describes — the paths, the shapes, the status
codes — is generated into :mod:`konusbitr._generated`. What it does *not*
describe is how a good client behaves: when to retry, how to back off, how to
wait for an asynchronous job, what to do with a ``Retry-After``. A generator's
guess at those would be worse than a page of deliberate code, so this is that
page.

Both a synchronous and an asynchronous client are provided, because both are
ordinary in Python and asking a caller to wrap one in the other is asking them
to get it wrong. They share every decision through :class:`_Transport`; only the
I/O differs.
"""

from __future__ import annotations

import asyncio
import random
import time
from typing import Any, BinaryIO

import httpx

from konusbitr._generated import API_VERSION, OPERATIONS, Operation
from konusbitr.errors import JobFailedError, KonusbitrError, RateLimitError

__all__ = ["API_VERSION", "AsyncKonusbitr", "Konusbitr"]

DEFAULT_MAX_RETRIES = 3
DEFAULT_TIMEOUT_SECONDS = 120.0


def _backoff_seconds(attempt: int) -> float:
    """Full jitter, capped. See AWS's "Exponential Backoff and Jitter"."""
    return random.random() * min(30.0, 0.5 * 2**attempt)


class _Transport:
    """Everything about a request that does not depend on being async."""

    def __init__(self, base_url: str, api_key: str, max_retries: int) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._max_retries = max_retries

    def url_for(
        self,
        operation: Operation,
        params: dict[str, str] | None,
        query: dict[str, str] | None,
    ) -> str:
        path = operation["path"]
        for name, value in (params or {}).items():
            path = path.replace("{" + name + "}", httpx.URL(path=value).path.lstrip("/"))

        # Both surfaces hang off one origin, and only the two legacy operations
        # live under `/v1`.
        prefix = "/v1" if path.startswith("/chat-with") else "/v2"
        request = httpx.URL(f"{self._base_url}{prefix}{path}")
        return str(request.copy_merge_params(query or {}))

    def headers(self, *, json_body: bool) -> dict[str, str]:
        headers = {"x-api-key": self._api_key, "accept": "application/json"}
        if json_body:
            headers["content-type"] = "application/json"
        return headers

    def interpret(self, response: httpx.Response) -> Any:
        """Return the body, or raise the documented error for a failure."""
        request_id = response.headers.get("x-request-id", "")
        try:
            body = response.json()
        except ValueError:
            body = None

        if response.is_success:
            return body

        error = KonusbitrError.from_response(response.status_code, body, request_id)
        if response.status_code == 429:
            raise RateLimitError(error, int(response.headers.get("retry-after", "1") or 1))
        raise error

    def should_retry(self, error: Exception, attempt: int) -> bool:
        if attempt >= self._max_retries:
            return False
        # A 4xx that is not a rate limit is the caller's request being wrong,
        # and sending it again is a slower way to get the same answer.
        if isinstance(error, KonusbitrError):
            return error.retryable
        return isinstance(error, httpx.TransportError)


class _Base:
    """The operation lookup and the argument shaping both clients share."""

    _transport: _Transport

    @staticmethod
    def _operation(name: str) -> Operation:
        operation = OPERATIONS.get(name)
        if operation is None:  # pragma: no cover - only reachable via a typo
            raise KeyError(f"no operation named {name!r}")
        return operation

    @staticmethod
    def _with_webhook(body: dict[str, Any], webhook_url: str | None) -> dict[str, Any]:
        return {**body, "webhook_url": webhook_url} if webhook_url else body


class Konusbitr(_Base):
    """A synchronous client.

    ::

        from konusbitr import Konusbitr

        client = Konusbitr(base_url="https://konusbitr.example.com", api_key="kb_…")
        doc = client.parse(url="https://example.com/report.pdf")
        answer = client.ask(doc_id=doc["docId"], question="What is the total?")
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        max_retries: int = DEFAULT_MAX_RETRIES,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._transport = _Transport(base_url, api_key, max_retries)
        self._owns_client = http_client is None
        self._http = http_client or httpx.Client(timeout=timeout)

    def close(self) -> None:
        if self._owns_client:
            self._http.close()

    def __enter__(self) -> Konusbitr:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ── The four v2 endpoints ────────────────────────────────────────────────

    def parse(self, *, file: BinaryIO | None = None, **body: Any) -> Any:
        """Parse a document into markdown and located elements."""
        return self._call("parse", body, file=file)

    def extract(self, *, file: BinaryIO | None = None, **body: Any) -> Any:
        """Extract structured data against a JSON Schema, with every value cited."""
        return self._call("extract", body, file=file)

    def split(self, *, file: BinaryIO | None = None, **body: Any) -> Any:
        """Split a document into separate documents, by page range or by section."""
        return self._call("split", body, file=file)

    def ask(self, *, file: BinaryIO | None = None, **body: Any) -> Any:
        """Ask a question and get an answer whose every claim is cited."""
        return self._call("ask", body, file=file)

    # ── Documents and jobs ───────────────────────────────────────────────────

    def get_document(self, doc_id: str) -> Any:
        """A document's status and page count. Free to poll."""
        return self._request(self._operation("getDocument"), params={"docId": doc_id})

    def delete_document(self, doc_id: str) -> Any:
        """Delete a document, its pages, its chunks and its stored bytes."""
        return self._request(self._operation("deleteDocument"), params={"docId": doc_id})

    def get_job(self, job_id: str) -> Any:
        """One asynchronous operation. Free to poll."""
        return self._request(self._operation("getJob"), params={"jobId": job_id})

    # ── Legacy ───────────────────────────────────────────────────────────────

    def chat_with_pdf(self, **body: Any) -> Any:
        """PDF.ai compatibility. Prefer :meth:`ask`."""
        return self._request(self._operation("chatWithPdf"), body=body)

    def chat_with_all_pdfs(self, **body: Any) -> Any:
        """PDF.ai compatibility. Prefer :meth:`ask` with ``corpus=True``."""
        return self._request(self._operation("chatWithAllPdfs"), body=body)

    # ── Asynchronous helpers ─────────────────────────────────────────────────

    def start(self, name: str, *, webhook_url: str | None = None, **body: Any) -> Any:
        """Start an operation without waiting, and get ``{"jobId": …}``.

        Use this rather than the blocking call for a long document: a parse of
        nine hundred pages holds a connection open for minutes, and anything
        between you and the API dropping it loses the result. The job's answer
        is durable and can be fetched later.
        """
        return self._request(
            self._operation(name),
            body=self._with_webhook(body, webhook_url),
            query={"async": "true"},
        )

    def wait_for_job(
        self,
        job_id: str,
        *,
        interval: float = 1.0,
        timeout: float = 900.0,
    ) -> Any:
        """Poll a job until it finishes, and return its result.

        A fixed interval rather than a backoff, because a caller who called this
        is waiting and the endpoint costs nothing to read. Raises
        :class:`~konusbitr.errors.JobFailedError` when the operation failed,
        carrying the same code the blocking call would have raised.
        """
        deadline = time.monotonic() + timeout

        while True:
            job = self.get_job(job_id)
            if job["status"] == "succeeded":
                return job["result"]
            if job["status"] == "failed":
                raise JobFailedError(job_id, _job_error(job))
            if time.monotonic() >= deadline:
                raise KonusbitrError(
                    "timeout",
                    f"Job {job_id} did not finish within the timeout.",
                    status=408,
                    details={"jobId": job_id, "status": job["status"]},
                )
            time.sleep(interval)

    # ── Transport ────────────────────────────────────────────────────────────

    def _call(
        self,
        name: str,
        body: dict[str, Any],
        *,
        file: BinaryIO | None,
        run_async: bool = False,
        webhook_url: str | None = None,
    ) -> Any:
        operation = self._operation(name)
        if not run_async:
            return self._request(operation, body=body, file=file)

        started = self.start(name, webhook_url=webhook_url, **body)
        return self.wait_for_job(started["jobId"])

    def _request(
        self,
        operation: Operation,
        *,
        body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
        query: dict[str, str] | None = None,
        file: BinaryIO | None = None,
    ) -> Any:
        url = self._transport.url_for(operation, params, query)
        last: Exception | None = None

        for attempt in range(self._transport._max_retries + 1):
            if attempt:
                time.sleep(_backoff_seconds(attempt))
            try:
                response = self._http.request(
                    operation["method"],
                    url,
                    **_payload(self._transport, body, file),
                )
                return self._transport.interpret(response)
            except Exception as error:
                last = error
                if not self._transport.should_retry(error, attempt):
                    raise

        assert last is not None
        raise last


class AsyncKonusbitr(_Base):
    """The same client, for an ``asyncio`` program."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        max_retries: int = DEFAULT_MAX_RETRIES,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._transport = _Transport(base_url, api_key, max_retries)
        self._owns_client = http_client is None
        self._http = http_client or httpx.AsyncClient(timeout=timeout)

    async def aclose(self) -> None:
        if self._owns_client:
            await self._http.aclose()

    async def __aenter__(self) -> AsyncKonusbitr:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def parse(self, *, file: BinaryIO | None = None, **body: Any) -> Any:
        return await self._request(self._operation("parse"), body=body, file=file)

    async def extract(self, *, file: BinaryIO | None = None, **body: Any) -> Any:
        return await self._request(self._operation("extract"), body=body, file=file)

    async def split(self, *, file: BinaryIO | None = None, **body: Any) -> Any:
        return await self._request(self._operation("split"), body=body, file=file)

    async def ask(self, *, file: BinaryIO | None = None, **body: Any) -> Any:
        return await self._request(self._operation("ask"), body=body, file=file)

    async def get_document(self, doc_id: str) -> Any:
        return await self._request(self._operation("getDocument"), params={"docId": doc_id})

    async def delete_document(self, doc_id: str) -> Any:
        return await self._request(self._operation("deleteDocument"), params={"docId": doc_id})

    async def get_job(self, job_id: str) -> Any:
        return await self._request(self._operation("getJob"), params={"jobId": job_id})

    async def chat_with_pdf(self, **body: Any) -> Any:
        return await self._request(self._operation("chatWithPdf"), body=body)

    async def chat_with_all_pdfs(self, **body: Any) -> Any:
        return await self._request(self._operation("chatWithAllPdfs"), body=body)

    async def start(self, name: str, *, webhook_url: str | None = None, **body: Any) -> Any:
        return await self._request(
            self._operation(name),
            body=self._with_webhook(body, webhook_url),
            query={"async": "true"},
        )

    async def wait_for_job(
        self,
        job_id: str,
        *,
        interval: float = 1.0,
        timeout: float = 900.0,
    ) -> Any:
        deadline = time.monotonic() + timeout

        while True:
            job = await self.get_job(job_id)
            if job["status"] == "succeeded":
                return job["result"]
            if job["status"] == "failed":
                raise JobFailedError(job_id, _job_error(job))
            if time.monotonic() >= deadline:
                raise KonusbitrError(
                    "timeout",
                    f"Job {job_id} did not finish within the timeout.",
                    status=408,
                    details={"jobId": job_id, "status": job["status"]},
                )
            await asyncio.sleep(interval)

    async def _request(
        self,
        operation: Operation,
        *,
        body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
        query: dict[str, str] | None = None,
        file: BinaryIO | None = None,
    ) -> Any:
        url = self._transport.url_for(operation, params, query)
        last: Exception | None = None

        for attempt in range(self._transport._max_retries + 1):
            if attempt:
                await asyncio.sleep(_backoff_seconds(attempt))
            try:
                response = await self._http.request(
                    operation["method"],
                    url,
                    **_payload(self._transport, body, file),
                )
                return self._transport.interpret(response)
            except Exception as error:
                last = error
                if not self._transport.should_retry(error, attempt):
                    raise

        assert last is not None
        raise last


def _payload(
    transport: _Transport,
    body: dict[str, Any] | None,
    file: BinaryIO | None,
) -> dict[str, Any]:
    """The httpx keyword arguments for one request.

    A `file` switches the request to `multipart/form-data`, where every other
    field travels as a form value. The two fields whose documented type is not a
    string are JSON-encoded, because a form value has no other way to be a list
    or an object — and the API decodes exactly those two back.
    """
    if file is None:
        if body is None:
            return {"headers": transport.headers(json_body=False)}
        return {"headers": transport.headers(json_body=True), "json": body}

    data = {
        key: (_as_form_value(value)) for key, value in (body or {}).items() if value is not None
    }
    return {
        "headers": transport.headers(json_body=False),
        "data": data,
        "files": {"file": file},
    }


def _as_form_value(value: Any) -> str:
    import json

    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(value)


def _job_error(job: dict[str, Any]) -> KonusbitrError:
    error = job.get("error") or {}
    return KonusbitrError(
        str(error.get("code") or "internal"),
        str(error.get("message") or "The operation failed."),
        status=500,
        details=error.get("details"),
        request_id=str(error.get("requestId") or ""),
    )
