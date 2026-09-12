"""Embeddings, through the router.

This is the only place in the worker that turns text into vectors, and it holds
three rules that are easy to lose.

**The width is checked before anything is stored.** ``chunks.embedding`` is
``vector(1024)`` — pgvector needs a fixed dimension to build an HNSW index — and
a model configured at another width does not fail loudly on its own. It returns
perfectly plausible numbers that occupy a different space, and cosine distance
between two spaces is noise that looks like a ranking. So the width is asserted
here, once, where the error can name the variable to change.

**A partial failure re-embeds only what failed.** A document is embedded in
batches; if batch nine of twelve times out, the eight that succeeded are kept
and the retry covers batch nine. Re-embedding the lot would triple the cost of
every transient blip on a large document.

**Order is restored, not assumed.** The OpenAI API documents input order, but a
proxy in the middle is under no such obligation, and a transposed batch attaches
every chunk's vector to its neighbour's text — a bug whose only symptom is worse
retrieval.
"""

from __future__ import annotations

import time
from collections.abc import Iterator, Sequence
from dataclasses import dataclass

from konusbitr_worker.ai.offline import assert_reachable
from konusbitr_worker.ai.resilience import (
    CircuitBreaker,
    ModelCallError,
    is_retryable_status,
    with_resilience,
)
from konusbitr_worker.ai.tokens import Tokenizer
from konusbitr_worker.ai.usage import UsageRecord, log_usage
from konusbitr_worker.log import get_logger
from konusbitr_worker.settings import (
    DEFAULT_EMBEDDING_MODELS,
    LOCAL_PROVIDERS,
    LlmProvider,
    Settings,
)

__all__ = [
    "EmbeddingDimensionError",
    "EmbeddingRouter",
    "ModelNotConfiguredError",
]

logger = get_logger("konusbitr.worker.ai.embeddings")


class ModelNotConfiguredError(RuntimeError):
    """No embedding model is configured.

    Not a failure. A stack with no embedding model still chunks a document and
    stores the passages — they are keyword-searchable immediately and gain
    vectors from the ``reindex`` that follows configuring a model. The pipeline
    catches this and says so; it is the same shape as ``SMTP_URL`` being unset.
    """

    def __init__(self) -> None:
        super().__init__(
            "No embedding model is configured. Set EMBEDDING_MODEL (and LLM_API_KEY "
            "for a cloud provider), or point LLM_PROVIDER at a local ollama or vllm. "
            "Until then documents are chunked and keyword-searchable but have no "
            "vectors; a reindex fills them in."
        )


class EmbeddingDimensionError(RuntimeError):
    """A model returned vectors the column cannot hold."""

    def __init__(self, expected: int, actual: int, model: str) -> None:
        super().__init__(
            f"{model} returned {actual}-dimensional vectors but chunks.embedding is "
            f"vector({expected}). Set EMBEDDING_DIMENSIONS and the column to the same "
            "width, then reindex every document — a mixed index returns nonsense "
            "rather than failing."
        )
        self.expected = expected
        self.actual = actual
        self.model = model


@dataclass(frozen=True, slots=True)
class EmbeddingModel:
    """The embedding role, resolved to something callable."""

    #: LiteLLM's ``provider/model`` spelling, which is what it is passed.
    name: str
    provider: LlmProvider
    #: ``None`` for a provider whose address LiteLLM knows.
    api_base: str | None
    api_key: str | None
    dimensions: int
    timeout_seconds: float


def resolve_embedding_model(settings: Settings) -> EmbeddingModel:
    """Work out what should embed, or raise :class:`ModelNotConfiguredError`."""
    provider = settings.provider_for("embedding")
    name = settings.model_for("embedding") or DEFAULT_EMBEDDING_MODELS.get(provider)

    # A local provider needs no key, so naming one is enough to mean business.
    # A cloud provider with no key is the untouched `LLM_PROVIDER=openai`
    # default, which is an unconfigured stack rather than a call that will 401.
    configured = provider in LOCAL_PROVIDERS or settings.llm_api_key is not None
    if name is None or not configured:
        raise ModelNotConfiguredError()

    api_base = settings.llm_base_url
    if api_base is None and provider == "ollama":
        api_base = settings.ollama_base_url
    if api_base is None and provider == "vllm":
        if settings.vllm_base_url is None:
            raise ValueError("VLLM_BASE_URL must be set when a role uses the vllm provider")
        api_base = settings.vllm_base_url

    # Checked here rather than at the call, so a misconfigured deployment fails
    # before a request body containing document text has been assembled at all.
    assert_reachable(settings, provider, api_base)

    return EmbeddingModel(
        name=name,
        provider=provider,
        api_base=api_base,
        api_key=settings.llm_api_key,
        dimensions=settings.embedding_dimensions,
        timeout_seconds=settings.embedding_timeout_seconds,
    )


class EmbeddingRouter:
    """Embeds text. One per job, so the breaker and tokenizer are shared by it."""

    def __init__(self, settings: Settings, *, model: EmbeddingModel | None = None) -> None:
        self._settings = settings
        self._model = model or resolve_embedding_model(settings)
        self._breaker = CircuitBreaker(
            failures=settings.model_breaker_failures,
            cooldown_seconds=settings.model_breaker_cooldown_seconds,
        )
        self._tokenizer = Tokenizer(self._model.name)

    @classmethod
    def configured(cls, settings: Settings) -> EmbeddingRouter | None:
        """The router, or ``None`` when no embedding model is configured.

        The pipeline uses this rather than catching, because "nothing is
        configured" is a state it renders rather than an error it handles.
        """
        try:
            return cls(settings)
        except ModelNotConfiguredError:
            logger.info("no embedding model configured; chunks will be stored without vectors")
            return None

    @property
    def model_name(self) -> str:
        return self._model.name

    @property
    def dimensions(self) -> int:
        return self._model.dimensions

    @property
    def tokenizer(self) -> Tokenizer:
        return self._tokenizer

    @property
    def batch_size(self) -> int:
        return self._settings.embedding_batch_size

    def batches(self, texts: Sequence[str]) -> Iterator[tuple[int, list[str]]]:
        """Split into provider-sized batches, yielding each with its offset.

        The offset comes back with the batch so that a caller embedding a
        document can attach vectors to chunks by position without holding the
        whole document's vectors in memory to line them up afterwards.
        """
        size = self.batch_size
        for start in range(0, len(texts), size):
            yield start, list(texts[start : start + size])

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """Embed one batch, in the order given."""
        if not texts:
            return []

        started = time.perf_counter()
        attempts = 0

        async def call(attempt: int) -> object:
            nonlocal attempts
            attempts = attempt
            return await self._request(list(texts))

        response = await with_resilience(
            call,
            role="embedding",
            attempts=self._settings.model_max_retries,
            breaker=self._breaker,
        )

        vectors = _ordered_vectors(response, len(texts), self._model.name)
        for vector in vectors:
            if len(vector) != self._model.dimensions:
                raise EmbeddingDimensionError(self._model.dimensions, len(vector), self._model.name)

        usage = getattr(response, "usage", None)
        prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
        log_usage(
            UsageRecord(
                role="embedding",
                provider=self._model.provider,
                model=self._model.name,
                items=len(texts),
                prompt_tokens=prompt_tokens,
                completion_tokens=0,
                duration_ms=int((time.perf_counter() - started) * 1000),
                attempts=attempts,
                cost_usd=_cost_of(response),
            )
        )
        return vectors

    async def _request(self, texts: list[str]) -> object:
        """One call to LiteLLM, with provider errors classified for the retry loop."""
        import litellm

        kwargs: dict[str, object] = {
            "model": self._model.name,
            "input": texts,
            "timeout": self._model.timeout_seconds,
        }
        if self._model.api_base is not None:
            kwargs["api_base"] = self._model.api_base
        if self._model.api_key is not None:
            kwargs["api_key"] = self._model.api_key
        # Only OpenAI's own endpoint takes `dimensions` — Matryoshka truncation
        # of `text-embedding-3-*`, which is what makes a cloud model fit the
        # same 1024-wide column as BGE-M3. Sending it to Ollama or vLLM is a 400
        # from a server that has never heard of it, so the width is *requested*
        # where it can be and *verified* everywhere.
        if self._model.provider == "openai":
            kwargs["dimensions"] = self._model.dimensions

        try:
            return await litellm.aembedding(**kwargs)
        except Exception as error:
            raise _classify(error) from error


def _classify(error: Exception) -> ModelCallError:
    """Turn a LiteLLM exception into a retry decision.

    The message is *not* forwarded: a provider that echoes its input back inside
    an error would put document text into a log line, and document text is
    untrusted data that never reaches telemetry. So the status code and the
    exception class name go in, and the body stays out.
    """
    status = getattr(error, "status_code", None)
    name = type(error).__name__

    if isinstance(status, int):
        return ModelCallError(
            f"the embedding provider answered {status} ({name})",
            role="embedding",
            retryable=is_retryable_status(status),
            status=status,
        )

    # No status: a transport failure, a timeout, a DNS problem. Retryable, for
    # the same reason an unrecognised job exception is: wrongly deciding
    # something is permanent costs somebody their document.
    return ModelCallError(
        f"the embedding provider could not be reached ({name})",
        role="embedding",
        retryable=True,
    )


def _ordered_vectors(response: object, expected: int, model: str) -> list[list[float]]:
    data = getattr(response, "data", None) or []
    if len(data) != expected:
        raise ModelCallError(
            f"{model} returned {len(data)} vectors for {expected} inputs",
            role="embedding",
            retryable=True,
        )

    # A list of `None` rather than a pre-sized list that is then checked with a
    # generator: a gap has to be detectable, and a sparse structure hides one.
    vectors: list[list[float] | None] = [None] * expected
    for position, entry in enumerate(data):
        index = _field(entry, "index", position)
        vector = _field(entry, "embedding", None)
        if vector is None or not isinstance(index, int) or not 0 <= index < expected:
            raise ModelCallError(
                f"{model} returned a malformed embedding entry",
                role="embedding",
                retryable=True,
            )
        vectors[index] = [float(value) for value in vector]

    if any(vector is None for vector in vectors):
        raise ModelCallError(
            f"{model} returned a batch with a gap in it", role="embedding", retryable=True
        )
    return [vector for vector in vectors if vector is not None]


def _field(entry: object, name: str, default: object) -> object:
    """Read a field from LiteLLM's response, which is a model or a dict by version."""
    if isinstance(entry, dict):
        return entry.get(name, default)
    return getattr(entry, name, default)


def _cost_of(response: object) -> float | None:
    """The provider's own cost figure, when LiteLLM could compute one.

    Asking LiteLLM rather than keeping a price table here: it already tracks
    published prices for every model it routes to, and a second table in this
    repository would be a table that goes stale on somebody else's release
    schedule. A local model has no published price, and the honest answer there
    is `None` — no marginal cost — rather than zero dollars of a metered spend.
    """
    hidden = getattr(response, "_hidden_params", None)
    if isinstance(hidden, dict):
        cost = hidden.get("response_cost")
        if isinstance(cost, (int, float)):
            return float(cost)
    return None
