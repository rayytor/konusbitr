"""Retries, backoff and a circuit breaker, around one model call.

Three failure shapes, three different right answers.

A 429 or a 503 is the provider asking for a moment: retry with exponential
backoff and **full jitter**. The jitter is not decoration. A worker embedding a
500-page document sends batches back to back, hits a rate limit on several of
them at once, and a fixed backoff synchronises those into a herd that hits the
same limit again in lockstep.

A 400 or a 401 is the request or the credential being wrong. Retrying is pure
latency, so it fails immediately, and — importantly — it does **not** count
towards the breaker: five malformed calls must not take a healthy provider
offline.

A provider that is genuinely down is why the breaker exists. Without one, a dead
endpoint costs every job ``attempts x timeout`` before failing, and a queue of a
hundred documents spends an hour discovering the same outage a hundred times.
"""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable

from konusbitr_worker.log import get_logger
from konusbitr_worker.settings import ModelRole

__all__ = [
    "CircuitBreaker",
    "CircuitOpenError",
    "ModelCallError",
    "is_retryable_status",
    "with_resilience",
]

logger = get_logger("konusbitr.worker.ai.resilience")

#: Status codes worth trying again.
#:
#: 408, 409 and 425 are in because some OpenAI-compatible servers use them for
#: "busy, come back" — vLLM under load, and Ollama while a model is still being
#: loaded into memory, which on a first call can be a minute.
_RETRYABLE_STATUSES = frozenset({408, 409, 425, 429, 499, 500, 502, 503, 504})

_DEFAULT_BASE_DELAY_SECONDS = 0.5


def is_retryable_status(status: int) -> bool:
    return status in _RETRYABLE_STATUSES


class ModelCallError(RuntimeError):
    """A model call that failed in a way worth naming."""

    def __init__(
        self,
        message: str,
        *,
        role: ModelRole,
        retryable: bool,
        status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.role = role
        self.retryable = retryable
        self.status = status


class CircuitOpenError(RuntimeError):
    """Raised while a role's circuit is open. Never retried: that is the point."""

    def __init__(self, role: ModelRole, reopens_in: float) -> None:
        super().__init__(
            f"The {role} provider has failed repeatedly; calls are being refused for "
            f"another {reopens_in:.0f}s. Fix the provider rather than waiting out one "
            "timeout per job."
        )
        self.role = role
        self.reopens_in = reopens_in


class CircuitBreaker:
    """One breaker per role.

    Per role rather than per process, because roles fail independently: a
    deployment with a cloud chat model and local embeddings has two providers,
    and an OpenAI outage must not stop the worker embedding.
    """

    def __init__(
        self,
        *,
        failures: int,
        cooldown_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._threshold = failures
        self._cooldown = cooldown_seconds
        self._clock = clock
        self._consecutive_failures = 0
        self._opened_at: float | None = None

    def assert_closed(self, role: ModelRole) -> None:
        if self._opened_at is None:
            return

        elapsed = self._clock() - self._opened_at
        if elapsed < self._cooldown:
            raise CircuitOpenError(role, self._cooldown - elapsed)

        # Half-open: let exactly one call through. The failure counter is left
        # where it is, so a single further failure re-opens the circuit
        # immediately rather than granting a fresh budget of attempts to a
        # provider that is still down.
        self._opened_at = None

    def record_success(self) -> None:
        self._consecutive_failures = 0
        self._opened_at = None

    def record_failure(self) -> None:
        self._consecutive_failures += 1
        if self._consecutive_failures >= self._threshold:
            self._opened_at = self._clock()
            logger.warning("model circuit opened", extra={"failures": self._consecutive_failures})

    @property
    def state(self) -> str:
        """``closed`` or ``open``. Reported by ``/health``, asserted by the tests."""
        if self._opened_at is None:
            return "closed"
        return "open" if self._clock() - self._opened_at < self._cooldown else "closed"


async def with_resilience[T](
    call: Callable[[int], Awaitable[T]],
    *,
    role: ModelRole,
    attempts: int,
    breaker: CircuitBreaker | None = None,
    base_delay_seconds: float = _DEFAULT_BASE_DELAY_SECONDS,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    jitter: Callable[[], float] = random.random,
) -> T:
    """Run a model call with retries, backoff and the role's breaker.

    The breaker is consulted before the first attempt and updated after the
    last, not per attempt: three attempts against one dead provider are one
    failure *of that provider*, and counting them separately would open the
    circuit on the first job rather than the fifth.
    """
    if breaker is not None:
        breaker.assert_closed(role)

    last_error: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            result = await call(attempt)
        except ModelCallError as error:
            last_error = error
            if not error.retryable:
                # Not evidence that the provider is unhealthy, so it must not
                # count towards the breaker.
                raise
        except Exception as error:
            # An unrecognised exception is treated as retryable, for the same
            # reason `internal` is a retryable job error code: wrongly deciding
            # something is permanent costs somebody their document.
            last_error = error
        else:
            if breaker is not None:
                breaker.record_success()
            return result

        if attempt == attempts:
            break
        # Full jitter: a uniform draw from [0, exponential] rather than the
        # exponential plus a little. It is what breaks the lockstep.
        await sleep(base_delay_seconds * 2 ** (attempt - 1) * jitter())

    if breaker is not None:
        breaker.record_failure()
    if last_error is None:  # pragma: no cover - the loop cannot exit without one
        raise RuntimeError("the retry loop ended with neither a result nor an error")
    raise last_error
