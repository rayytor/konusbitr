"""Token and cost accounting, emitted once per model call.

Phase 15 points this at Langfuse and Phase 13 bills on it. Both need the same
record, which is why it is collected from the start rather than added when
something consumes it: a usage series that begins the day observability ships
is a usage series with nothing to compare against.

What is deliberately absent is any of the text. A usage record goes to logs an
operator reads and, later, to a third-party platform — and document text is
untrusted input that must reach neither. So the record carries counts and
identifiers, and the closest it comes to content is how many items were in the
batch.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from konusbitr_worker.log import get_logger
from konusbitr_worker.settings import LlmProvider, ModelRole

__all__ = ["UsageRecord", "log_usage"]

logger = get_logger("konusbitr.worker.ai.usage")


@dataclass(frozen=True, slots=True)
class UsageRecord:
    """One model call, as accounting sees it."""

    role: ModelRole
    provider: LlmProvider
    model: str
    #: Items in this call: passages embedded, messages sent, documents reranked.
    items: int
    prompt_tokens: int
    completion_tokens: int
    #: Wall clock for the call, retries included.
    duration_ms: int
    #: Attempts spent, the first included.
    attempts: int
    #: Estimated USD, or ``None`` when the model has no published price — which
    #: is every local model, where the honest answer is "no marginal cost"
    #: rather than zero dollars of a metered spend.
    cost_usd: float | None

    def to_json(self) -> dict[str, object]:
        return asdict(self)


def log_usage(record: UsageRecord) -> None:
    logger.info("model call", extra={"usage": record.to_json()})
