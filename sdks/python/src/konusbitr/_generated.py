"""Generated from the API's OpenAPI document by ``scripts/generate.py``.

**Do not edit.** Run ``make generate`` instead; CI regenerates this module and
fails on any diff.
"""

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict


class ApiDocument(TypedDict):
    docId: str
    filename: str
    status: str
    pageCount: int | None
    byteSize: int
    createdAt: str
    updatedAt: str
    error: str | None
    errorCode: str | None


class ApiError(TypedDict):
    error: dict[str, Any]


ApiErrorCode = Literal[
    "invalid_request",
    "invalid_json",
    "input_conflict",
    "input_missing",
    "invalid_schema",
    "invalid_ranges",
    "invalid_webhook_url",
    "unknown_document",
    "unauthorized",
    "missing_scope",
    "session_required",
    "insufficient_role",
    "not_found",
    "document_not_ready",
    "document_failed",
    "too_large",
    "unsupported_media_type",
    "invalid_document",
    "encrypted_document",
    "needs_ocr",
    "too_many_pages",
    "insufficient_credits",
    "rate_limited",
    "internal",
    "model_unavailable",
    "upstream_unavailable",
]


class ApiJob(TypedDict):
    jobId: str
    kind: ApiJobKind
    status: ApiJobStatus
    docId: str | None
    progress: int
    result: Any | None
    error: dict[str, Any] | None
    createdAt: str
    updatedAt: str


ApiJobKind = Literal["parse", "extract", "split", "ask"]

ApiJobStatus = Literal["pending", "running", "succeeded", "failed"]


class AskRequest(TypedDict):
    url: NotRequired[str]
    docId: NotRequired[str]
    quality: NotRequired[Literal["standard", "advanced"]]
    lang_list: NotRequired[list[str]]
    llm: NotRequired[bool]
    webhook_url: NotRequired[str]
    question: str
    language: NotRequired[str]
    corpus: NotRequired[bool]


class AskResponse(TypedDict):
    answer: str
    citations: list[Citation]
    docId: str | None


BoundingBox = tuple[float, float, float, float]


class ChatWithAllPdfsRequest(TypedDict):
    question: NotRequired[str]
    prompt: NotRequired[str]
    language: NotRequired[str]
    docIds: NotRequired[list[str]]


class ChatWithPdfRequest(TypedDict):
    url: NotRequired[str]
    docId: NotRequired[str]
    question: NotRequired[str]
    prompt: NotRequired[str]
    language: NotRequired[str]


class ChatWithPdfResponse(TypedDict):
    content: str
    references: list[LegacyReference]


class Citation(TypedDict):
    quote: str
    page: int
    bbox: BoundingBox
    chunkId: str
    documentId: NotRequired[str]
    schemaPath: NotRequired[str]


class ExtractRequest(TypedDict):
    url: NotRequired[str]
    docId: NotRequired[str]
    quality: NotRequired[Literal["standard", "advanced"]]
    lang_list: NotRequired[list[str]]
    llm: NotRequired[bool]
    webhook_url: NotRequired[str]
    schema: dict[str, Any]
    system_prompt: NotRequired[str]


class ExtractResponse(TypedDict):
    docId: str
    result: dict[str, Any]
    citations: list[Citation]
    unverified: list[dict[str, Any]]


class ExtractedImage(TypedDict):
    id: str
    page: int
    bbox: BoundingBox
    width: int
    height: int
    storageKey: str
    caption: str | None


class LegacyReference(TypedDict):
    page: int
    quote: str
    docId: str | None
    bbox: tuple[float, float, float, float]


PageRange = str | dict[str, Any]


class ParseRequest(TypedDict):
    url: NotRequired[str]
    docId: NotRequired[str]
    quality: NotRequired[Literal["standard", "advanced"]]
    lang_list: NotRequired[list[str]]
    llm: NotRequired[bool]
    webhook_url: NotRequired[str]
    filename: NotRequired[str]


class ParseResponse(TypedDict):
    docId: str
    markdown: str
    contents: list[ParsedElement]
    images: list[ExtractedImage]
    pageCount: int
    cached: bool


class ParsedElement(TypedDict):
    type: str
    page: int
    bbox: tuple[float, float, float, float]
    text: str | None
    markdown: str | None
    headers: list[str] | None
    rows: list[list[str]] | None
    level: int | None
    sectionPath: str | None


class SplitRequest(TypedDict):
    url: NotRequired[str]
    docId: NotRequired[str]
    quality: NotRequired[Literal["standard", "advanced"]]
    lang_list: NotRequired[list[str]]
    llm: NotRequired[bool]
    webhook_url: NotRequired[str]
    ranges: NotRequired[list[PageRange]]
    mode: NotRequired[Literal["ranges", "semantic"]]
    level: NotRequired[int]


class SplitResponse(TypedDict):
    docId: str
    documents: list[dict[str, Any]]


class Operation(TypedDict):
    """One endpoint, as the client needs to call it."""

    method: str
    path: str
    params: list[str]
    body: Literal["json", "json-or-multipart", "none"]
    status: int
    supports_async: bool


#: The API version this module was generated from.
API_VERSION = "0.1.0"


OPERATIONS: dict[str, Operation] = {
    "ask": {
        "method": "POST",
        "path": "/ask",
        "params": [],
        "body": "json-or-multipart",
        "status": 200,
        "supports_async": True,
    },
    "chatWithAllPdfs": {
        "method": "POST",
        "path": "/chat-with-all-pdfs",
        "params": [],
        "body": "json",
        "status": 200,
        "supports_async": False,
    },
    "chatWithPdf": {
        "method": "POST",
        "path": "/chat-with-pdf",
        "params": [],
        "body": "json",
        "status": 200,
        "supports_async": False,
    },
    "deleteDocument": {
        "method": "DELETE",
        "path": "/documents/{docId}",
        "params": ["docId"],
        "body": "none",
        "status": 200,
        "supports_async": False,
    },
    "getDocument": {
        "method": "GET",
        "path": "/documents/{docId}",
        "params": ["docId"],
        "body": "none",
        "status": 200,
        "supports_async": False,
    },
    "extract": {
        "method": "POST",
        "path": "/extract",
        "params": [],
        "body": "json-or-multipart",
        "status": 200,
        "supports_async": True,
    },
    "getJob": {
        "method": "GET",
        "path": "/jobs/{jobId}",
        "params": ["jobId"],
        "body": "none",
        "status": 200,
        "supports_async": False,
    },
    "parse": {
        "method": "POST",
        "path": "/parse",
        "params": [],
        "body": "json-or-multipart",
        "status": 200,
        "supports_async": True,
    },
    "split": {
        "method": "POST",
        "path": "/split",
        "params": [],
        "body": "json-or-multipart",
        "status": 200,
        "supports_async": True,
    },
}
