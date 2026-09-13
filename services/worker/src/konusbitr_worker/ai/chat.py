"""Chat completions, through the router.

The worker needs a chat model for exactly one thing in Phase 09: the document
summary that two-stage corpus retrieval searches first. That summary is not
decoration. On a corpus past ``CORPUS_TWO_STAGE_THRESHOLD`` documents it is the
*only* thing consulted in the first stage, so a document whose summary is its
first two hundred words is a document that gets found by its cover page and its
table of contents rather than by what it is about.

Everything structural here mirrors :mod:`konusbitr_worker.ai.embeddings` —
role resolution, offline enforcement at the call site, retry with the shared
breaker, usage accounting, and no provider SDK anywhere — because the router is
one contract with four roles rather than four routers.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from konusbitr_worker.ai.embeddings import ModelNotConfiguredError
from konusbitr_worker.ai.offline import assert_reachable
from konusbitr_worker.ai.resilience import (
    CircuitBreaker,
    ModelCallError,
    is_retryable_status,
    with_resilience,
)
from konusbitr_worker.ai.usage import UsageRecord, log_usage
from konusbitr_worker.log import get_logger
from konusbitr_worker.settings import (
    DEFAULT_CHAT_MODELS,
    LOCAL_PROVIDERS,
    LlmProvider,
    Settings,
)

__all__ = ["ChatModel", "ChatRouter", "resolve_chat_model"]

logger = get_logger("konusbitr.worker.ai.chat")


@dataclass(frozen=True, slots=True)
class ChatModel:
    """The chat role, resolved to something callable."""

    name: str
    provider: LlmProvider
    api_base: str | None
    api_key: str | None
    timeout_seconds: float


def resolve_chat_model(settings: Settings) -> ChatModel:
    """Work out what should answer, or raise :class:`ModelNotConfiguredError`."""
    provider = settings.provider_for("chat")
    name = settings.model_for("chat") or DEFAULT_CHAT_MODELS.get(provider)

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

    # Enforced here as well as at boot, because configuration can change under a
    # running process and `OFFLINE_MODE` is a headline claim rather than a hint.
    assert_reachable(settings, provider, api_base)

    return ChatModel(
        name=name,
        provider=provider,
        api_base=api_base,
        api_key=settings.llm_api_key,
        timeout_seconds=settings.model_timeout_seconds,
    )


class ChatRouter:
    """Completes chat prompts. One per job, so the breaker is shared by it."""

    def __init__(self, settings: Settings, *, model: ChatModel | None = None) -> None:
        self._settings = settings
        self._model = model or resolve_chat_model(settings)
        self._breaker = CircuitBreaker(
            failures=settings.model_breaker_failures,
            cooldown_seconds=settings.model_breaker_cooldown_seconds,
        )

    @classmethod
    def configured(cls, settings: Settings) -> ChatRouter | None:
        """The router, or ``None`` when no chat model is configured.

        ``None`` is a supported state, not a failure: a stack with no chat model
        still parses, chunks and embeds. What it loses is the generated document
        summary, and the caller falls back to a lead-paragraph extract rather
        than failing a job over it.
        """
        try:
            return cls(settings)
        except ModelNotConfiguredError:
            logger.info("no chat model configured; document summaries will be extractive")
            return None

    @property
    def model_name(self) -> str:
        return self._model.name

    async def complete(
        self,
        *,
        system: str,
        user: str,
        max_tokens: int,
        temperature: float = 0.2,
    ) -> str:
        """One completion, returning its text."""
        started = time.perf_counter()
        attempts = 0

        async def call(attempt: int) -> object:
            nonlocal attempts
            attempts = attempt
            return await self._request(
                system=system, user=user, max_tokens=max_tokens, temperature=temperature
            )

        response = await with_resilience(
            call,
            role="chat",
            attempts=self._settings.model_max_retries,
            breaker=self._breaker,
        )

        usage = getattr(response, "usage", None)
        log_usage(
            UsageRecord(
                role="chat",
                provider=self._model.provider,
                model=self._model.name,
                items=1,
                prompt_tokens=int(getattr(usage, "prompt_tokens", 0) or 0),
                completion_tokens=int(getattr(usage, "completion_tokens", 0) or 0),
                duration_ms=int((time.perf_counter() - started) * 1000),
                attempts=attempts,
                cost_usd=_cost_of(response),
            )
        )

        return _first_message(response)

    async def _request(
        self, *, system: str, user: str, max_tokens: int, temperature: float
    ) -> object:
        import litellm

        kwargs: dict[str, object] = {
            "model": self._model.name,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": max_tokens,
            "temperature": temperature,
            "timeout": self._model.timeout_seconds,
        }
        if self._model.api_base is not None:
            kwargs["api_base"] = self._model.api_base
        if self._model.api_key is not None:
            kwargs["api_key"] = self._model.api_key

        try:
            return await litellm.acompletion(**kwargs)
        except Exception as error:
            raise _classify(error) from error


def _classify(error: Exception) -> ModelCallError:
    """Turn a LiteLLM exception into a retry decision.

    As in the embedding router, the provider's message is deliberately not
    forwarded: a provider that echoes its input back inside an error would put
    document text into a log line, and document text never reaches telemetry.
    """
    status = getattr(error, "status_code", None)
    name = type(error).__name__

    if isinstance(status, int):
        return ModelCallError(
            f"the chat provider answered {status} ({name})",
            role="chat",
            retryable=is_retryable_status(status),
            status=status,
        )

    return ModelCallError(
        f"the chat provider could not be reached ({name})",
        role="chat",
        retryable=True,
    )


def _first_message(response: object) -> str:
    choices = getattr(response, "choices", None) or []
    if not choices:
        raise ModelCallError("the chat provider returned no choices", role="chat", retryable=True)

    first = choices[0]
    message = first.get("message") if isinstance(first, dict) else getattr(first, "message", None)
    if message is None:
        raise ModelCallError("the chat provider returned no message", role="chat", retryable=True)

    content = (
        message.get("content") if isinstance(message, dict) else getattr(message, "content", None)
    )
    return str(content or "").strip()


def _cost_of(response: object) -> float | None:
    hidden = getattr(response, "_hidden_params", None)
    if isinstance(hidden, dict):
        cost = hidden.get("response_cost")
        if isinstance(cost, (int, float)):
            return float(cost)
    return None
