"""Typed errors, so a caller can branch on what went wrong.

The API returns one envelope for every failure with a code from a closed,
documented set, so the SDK's job is to turn that into something an ``except``
clause can discriminate on rather than a string to match against.

Hand-written rather than generated: what a client *does* with a failure is not
something an OpenAPI document describes.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "JobFailedError",
    "KonusbitrError",
    "RateLimitError",
]


class KonusbitrError(Exception):
    """A failure the API reported, with its documented code."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int,
        details: dict[str, Any] | None = None,
        request_id: str = "",
    ) -> None:
        super().__init__(message)
        #: A stable code from the API's documented set. Switch on this.
        self.code = code
        self.message = message
        self.status = status
        #: Machine-readable specifics: the conflicting fields, the missing scope.
        self.details = details or {}
        #: Matches the ``X-Request-Id`` header. Quote it in a bug report.
        self.request_id = request_id

    @classmethod
    def from_response(
        cls,
        status: int,
        body: Any,
        fallback_request_id: str,
    ) -> KonusbitrError:
        envelope = body.get("error") if isinstance(body, dict) else None
        if not isinstance(envelope, dict):
            return cls(
                "internal",
                f"The API returned {status} with no error body.",
                status=status,
                request_id=fallback_request_id,
            )
        return cls(
            str(envelope.get("code") or "internal"),
            str(envelope.get("message") or "The request failed."),
            status=status,
            details=envelope.get("details"),
            request_id=str(envelope.get("requestId") or fallback_request_id),
        )

    @property
    def retryable(self) -> bool:
        """Whether sending the same request again could plausibly succeed."""
        return self.status == 429 or self.status >= 500

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"KonusbitrError(code={self.code!r}, status={self.status}, message={self.message!r})"


class RateLimitError(KonusbitrError):
    """A 429. Carries the ``Retry-After`` the API asked for, in seconds."""

    def __init__(self, base: KonusbitrError, retry_after_seconds: int) -> None:
        super().__init__(
            base.code,
            base.message,
            status=base.status,
            details=base.details,
            request_id=base.request_id,
        )
        self.retry_after_seconds = retry_after_seconds


class JobFailedError(KonusbitrError):
    """An ``?async=true`` operation that finished in a failed state."""

    def __init__(self, job_id: str, base: KonusbitrError) -> None:
        super().__init__(
            base.code,
            base.message,
            status=base.status,
            details=base.details,
            request_id=base.request_id,
        )
        self.job_id = job_id
