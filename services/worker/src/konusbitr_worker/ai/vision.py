"""The vision role, through the router.

Two jobs, and the difference between them is the whole of Phase 12.3.

**Describing a figure** (Phase 12.2). A bar chart is the answer to "which region
grew fastest?" and is invisible to a text index, so the image is shown to a
vision model and the description it returns is what gets embedded and retrieved.
The citation still points at the figure's own rectangle on its own page, so a
reader can check the claim against the picture.

**Reading a whole page into structured elements** (Phase 12.3). The same
transport, a different ask: a page image in, a JSON array of located blocks in
reading order out. What it buys is the one thing no extractor recovers — the
sequence a person reads a multi-column page in — and what it costs is a token
bill per page, which is why :meth:`VisionRouter.read_page` sends a hard
`max_tokens` and why the caller counts pages before it starts.

Structurally identical to :mod:`konusbitr_worker.ai.chat` — role resolution,
offline enforcement at the call site, retry with the shared breaker, usage
accounting, and no provider SDK anywhere — because the router is one contract
with four roles rather than four routers. The only thing that differs is the
message shape: a `content` array with a text part and an `image_url` part, which
is the spelling every provider LiteLLM fronts accepts.

Images are sent as `data:` URIs rather than as links. A link would mean the
provider fetching the object out of our bucket, which needs the bucket to be
reachable from the internet — the opposite of what a self-hosted install is for.

**This is the one place document *pixels* leave the building**, and only when
the upload asked for it: `settings.llm` is false by default, and under
`OFFLINE_MODE` a cloud vision provider fails the process at boot and the call
site again here. Nothing about that is incidental.
"""

from __future__ import annotations

import base64
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
    DEFAULT_VISION_MODELS,
    LOCAL_PROVIDERS,
    LlmProvider,
    Settings,
)

__all__ = ["VisionModel", "VisionRouter", "resolve_vision_model"]

logger = get_logger("konusbitr.worker.ai.vision")


@dataclass(frozen=True, slots=True)
class VisionModel:
    """The vision role, resolved to something callable."""

    name: str
    provider: LlmProvider
    api_base: str | None
    api_key: str | None
    timeout_seconds: float


def resolve_vision_model(settings: Settings) -> VisionModel:
    """Work out what should look, or raise :class:`ModelNotConfiguredError`."""
    provider = settings.provider_for("vision")
    name = settings.model_for("vision") or DEFAULT_VISION_MODELS.get(provider)

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

    return VisionModel(
        name=name,
        provider=provider,
        api_base=api_base,
        api_key=settings.llm_api_key,
        timeout_seconds=settings.model_timeout_seconds,
    )


class VisionRouter:
    """Describes images. One per job, so the breaker is shared by it."""

    def __init__(self, settings: Settings, *, model: VisionModel | None = None) -> None:
        self._settings = settings
        self._model = model or resolve_vision_model(settings)
        self._breaker = CircuitBreaker(
            failures=settings.model_breaker_failures,
            cooldown_seconds=settings.model_breaker_cooldown_seconds,
        )

    @classmethod
    def configured(cls, settings: Settings) -> VisionRouter | None:
        """The router, or ``None`` when no vision model is configured.

        ``None`` is a supported state, not a failure, and it is the default: the
        stack in `docker compose up` has no API key. What a document loses is
        captions on its figures — the figures are still extracted, stored and
        located — and a `reindex` after configuring a model does not recover
        them, because captioning happens in the parse. Re-uploading does.
        """
        try:
            return cls(settings)
        except ModelNotConfiguredError:
            logger.info("no vision model configured; figures will be stored without captions")
            return None

    @property
    def model_name(self) -> str:
        return self._model.name

    async def describe(
        self,
        *,
        system: str,
        prompt: str,
        image: bytes,
        media_type: str = "image/png",
        max_tokens: int = 200,
        temperature: float = 0.0,
    ) -> str:
        """Describe one image, returning the text.

        `temperature=0.0` by default and not by accident. A caption is indexed
        and retrieved, so two parses of the same document should produce the same
        chunk — a figure whose description drifts between runs makes the docId
        cache a lie and makes an eval score unattributable.
        """
        started = time.perf_counter()
        attempts = 0
        encoded = base64.b64encode(image).decode("ascii")

        async def call(attempt: int) -> object:
            nonlocal attempts
            attempts = attempt
            return await self._request(
                system=system,
                prompt=prompt,
                data_uri=f"data:{media_type};base64,{encoded}",
                max_tokens=max_tokens,
                temperature=temperature,
            )

        response = await with_resilience(
            call,
            role="vision",
            attempts=self._settings.model_max_retries,
            breaker=self._breaker,
        )

        usage = getattr(response, "usage", None)
        log_usage(
            UsageRecord(
                role="vision",
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

    async def read_page(
        self,
        *,
        system: str,
        prompt: str,
        image: bytes,
        media_type: str = "image/png",
        max_tokens: int = 1500,
    ) -> str:
        """Read one page image, returning whatever the model answered, verbatim.

        Deliberately returns the raw string rather than parsed elements.
        Everything a model does wrong with a JSON contract — a code fence, a
        sentence of preamble, an axis order of its own — is a *parsing* problem,
        and it belongs in :mod:`konusbitr_worker.parse.vlm.response` where it
        can be tested against recorded answers without a provider. The router's
        job ends at the bytes.

        No `response_format` is sent. LiteLLM emulates JSON mode differently
        across the providers this router fronts and silently ignores it on
        several, so a parser that could cope with prose was needed regardless —
        and once it exists, the flag buys nothing but a provider-specific
        failure mode. The prompt asks for JSON and the parser insists on it.

        `temperature=0.0`, as everywhere else in the parse path: a document
        re-parsed with the same settings must produce the same artifact, or the
        docId cache is a lie and an eval score is unattributable.
        """
        return await self.describe(
            system=system,
            prompt=prompt,
            image=image,
            media_type=media_type,
            max_tokens=max_tokens,
            temperature=0.0,
        )

    async def _request(
        self,
        *,
        system: str,
        prompt: str,
        data_uri: str,
        max_tokens: int,
        temperature: float,
    ) -> object:
        import litellm

        kwargs: dict[str, object] = {
            "model": self._model.name,
            "messages": [
                {"role": "system", "content": system},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": data_uri}},
                    ],
                },
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

    As in the chat and embedding routers, the provider's message is deliberately
    not forwarded: a provider that echoes its input back inside an error would
    put document content into a log line, and document content never reaches
    telemetry.
    """
    status = getattr(error, "status_code", None)
    name = type(error).__name__

    if isinstance(status, int):
        return ModelCallError(
            f"the vision provider answered {status} ({name})",
            role="vision",
            retryable=is_retryable_status(status),
            status=status,
        )

    return ModelCallError(
        f"the vision provider could not be reached ({name})",
        role="vision",
        retryable=True,
    )


def _first_message(response: object) -> str:
    choices = getattr(response, "choices", None) or []
    if not choices:
        raise ModelCallError(
            "the vision provider returned no choices", role="vision", retryable=True
        )

    first = choices[0]
    message = first.get("message") if isinstance(first, dict) else getattr(first, "message", None)
    if message is None:
        raise ModelCallError(
            "the vision provider returned no message", role="vision", retryable=True
        )

    content = (
        message.get("content") if isinstance(message, dict) else getattr(message, "content", None)
    )
    if isinstance(content, list):
        # Some providers answer a multimodal request with a content array even
        # when every part of the answer is text.
        parts = [
            str(part.get("text") or "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        ]
        return " ".join(part for part in parts if part).strip()
    return str(content or "").strip()


def _cost_of(response: object) -> float | None:
    hidden = getattr(response, "_hidden_params", None)
    if isinstance(hidden, dict):
        cost = hidden.get("response_cost")
        if isinstance(cost, (int, float)):
            return float(cost)
    return None
