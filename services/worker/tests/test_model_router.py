"""The model router: offline mode, role resolution, retries, the breaker.

Offline mode is a headline claim of the project — legal, medical and government
users install Konusbitr precisely because a document cannot leave the building —
so it is tested twice over, at boot and at the call site, in that order.
"""

from __future__ import annotations

from typing import Any

import pytest

from konusbitr_worker.ai.embeddings import (
    EmbeddingRouter,
    ModelNotConfiguredError,
    resolve_embedding_model,
)
from konusbitr_worker.ai.offline import OfflineModeError, is_local_endpoint
from konusbitr_worker.ai.resilience import (
    CircuitBreaker,
    CircuitOpenError,
    ModelCallError,
    is_retryable_status,
    with_resilience,
)
from konusbitr_worker.ai.tokens import Tokenizer
from konusbitr_worker.settings import EnvValidationError, Settings, load_settings
from tests.factories import BASE_ENV


def settings_with(**overrides: Any) -> Settings:
    return Settings(_env_file=None, **BASE_ENV, **overrides)


# ── Offline mode at boot ─────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "LLM_PROVIDER",
        "LLM_API_KEY",
        "LLM_BASE_URL",
        "CHAT_PROVIDER",
        "EMBEDDING_PROVIDER",
        "EMBEDDING_MODEL",
        "OFFLINE_MODE",
        "OLLAMA_BASE_URL",
        "VLLM_BASE_URL",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("KONUSBITR_ENV_FILE", "/nonexistent/.env")


def boot(env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> Settings:
    """Load settings the way the container does: from the environment."""
    for key, value in {k.upper(): v for k, v in BASE_ENV.items()}.items():
        monkeypatch.setenv(key, value)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return load_settings(_env_file=None)


def test_offline_mode_refuses_to_start_against_a_cloud_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(EnvValidationError) as caught:
        boot({"OFFLINE_MODE": "true", "LLM_PROVIDER": "openai"}, monkeypatch)

    assert "OFFLINE_MODE" in str(caught.value)
    assert "LLM_PROVIDER=openai" in str(caught.value)


def test_offline_mode_catches_a_single_role_reaching_the_cloud(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The case a check on LLM_PROVIDER alone would miss.

    Everything local except the chat model, which is still a document leaving
    the building.
    """
    with pytest.raises(EnvValidationError) as caught:
        boot(
            {"OFFLINE_MODE": "true", "LLM_PROVIDER": "ollama", "CHAT_PROVIDER": "openai"},
            monkeypatch,
        )

    assert "CHAT_PROVIDER=openai" in str(caught.value)


def test_offline_mode_refuses_a_proxy_hosted_on_the_internet(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(EnvValidationError) as caught:
        boot(
            {
                "OFFLINE_MODE": "true",
                "LLM_PROVIDER": "ollama",
                "LLM_BASE_URL": "https://proxy.example.com/v1",
            },
            monkeypatch,
        )

    assert "LLM_BASE_URL" in str(caught.value)


def test_offline_mode_starts_with_only_ollama_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = boot(
        {
            "OFFLINE_MODE": "true",
            "LLM_PROVIDER": "ollama",
            "EMBEDDING_MODEL": "ollama/bge-m3",
            "OLLAMA_BASE_URL": "http://ollama:11434",
        },
        monkeypatch,
    )

    assert settings.offline_mode is True
    model = resolve_embedding_model(settings)
    assert model.name == "ollama/bge-m3"
    assert model.api_base == "http://ollama:11434"


def test_a_provider_with_no_embedding_endpoint_is_refused_at_boot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(EnvValidationError) as caught:
        boot(
            {
                "EMBEDDING_PROVIDER": "anthropic",
                "EMBEDDING_MODEL": "claude-sonnet-4-5",
                "LLM_API_KEY": "sk-test",
            },
            monkeypatch,
        )

    assert "EMBEDDING_PROVIDER" in str(caught.value)


# ── Offline mode at the call site ────────────────────────────────────────────


def drifted(**overrides: Any) -> Settings:
    """Settings the boot check would have refused.

    `model_copy` deliberately skips the validators, which makes it a faithful
    stand-in for the case the call-site check exists for: configuration that
    changed *after* a process started and passed its boot check. There is no
    other way to reach this state, and if there were, the boot check would be
    the thing that was broken.
    """
    return settings_with(llm_provider="ollama", embedding_model="ollama/bge-m3").model_copy(
        update=overrides
    )


def test_offline_mode_is_enforced_again_when_a_role_resolves() -> None:
    """Configuration can change under a running process.

    A guarantee that lapses at the next `kubectl set env` is not the guarantee
    this software was installed for, so the check is repeated where the call is
    made — and before any request body containing document text is assembled.
    """
    settings = drifted(offline_mode=True, embedding_provider="openai", llm_api_key="sk-test")

    with pytest.raises(OfflineModeError):
        resolve_embedding_model(settings)


def test_a_local_provider_pointed_at_a_public_host_is_still_a_cloud_call() -> None:
    # Checking the provider alone would let this through.
    settings = drifted(
        offline_mode=True, ollama_base_url="https://ollama.somebody-elses-cloud.example"
    )

    with pytest.raises(OfflineModeError):
        resolve_embedding_model(settings)


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://localhost:11434",
        "http://ollama:11434",
        "http://127.0.0.1:8000",
        "http://10.1.2.3:8000",
        "http://192.168.1.5:8000",
        "http://172.16.0.9:8000",
    ],
)
def test_local_endpoints(endpoint: str) -> None:
    assert is_local_endpoint(endpoint) is True


@pytest.mark.parametrize(
    "endpoint",
    ["https://api.openai.com", "https://api.mistral.ai/v1", "http://172.32.0.1:8000", "nonsense"],
)
def test_endpoints_that_are_not_local(endpoint: str) -> None:
    assert is_local_endpoint(endpoint) is False


# ── Role resolution ──────────────────────────────────────────────────────────


def test_a_role_takes_its_provider_default_when_only_a_provider_is_named() -> None:
    model = resolve_embedding_model(settings_with(llm_provider="openai", llm_api_key="sk-test"))

    assert model.name == "text-embedding-3-large"
    # `api_base` stays unset: LiteLLM knows where OpenAI is, and inventing a URL
    # here would be a second place that has to be right.
    assert model.api_base is None


def test_roles_are_configured_independently() -> None:
    """Cloud chat, local embeddings — the shape a law firm wants."""
    settings = settings_with(
        llm_provider="openai",
        llm_api_key="sk-test",
        embedding_provider="ollama",
        embedding_model="ollama/bge-m3",
        ollama_base_url="http://ollama:11434",
    )

    assert settings.provider_for("chat") == "openai"
    model = resolve_embedding_model(settings)
    assert model.provider == "ollama"
    assert model.api_base == "http://ollama:11434"


def test_an_unconfigured_role_is_not_an_error_the_pipeline_has_to_catch() -> None:
    """The default `.env.example`: `LLM_PROVIDER=openai` and no key.

    That must not resolve to a call that 401s. It is an unconfigured stack, and
    `configured()` says so by returning `None` so that the pipeline can chunk
    without embedding rather than failing a job.
    """
    settings = settings_with()

    with pytest.raises(ModelNotConfiguredError):
        resolve_embedding_model(settings)
    assert EmbeddingRouter.configured(settings) is None


def test_a_local_provider_needs_no_key_to_count_as_configured() -> None:
    router = EmbeddingRouter.configured(settings_with(llm_provider="ollama"))

    assert router is not None
    assert router.model_name == "ollama/bge-m3"


def test_vllm_needs_a_base_url_before_it_can_be_reached() -> None:
    with pytest.raises(ValueError, match="VLLM_BASE_URL"):
        resolve_embedding_model(
            settings_with(llm_provider="vllm", embedding_model="hosted_vllm/BAAI/bge-m3")
        )


def test_switching_the_embedding_model_is_configuration_only() -> None:
    """The acceptance criterion, stated as a test.

    Two deployments differing only in `.env` resolve to two different models
    with no code path in common beyond this function — which is what "plus a
    reindex, with no code change" means.
    """
    cloud = resolve_embedding_model(settings_with(llm_provider="openai", llm_api_key="sk-test"))
    local = resolve_embedding_model(
        settings_with(llm_provider="ollama", embedding_model="ollama/bge-m3")
    )

    assert cloud.name != local.name
    assert cloud.dimensions == local.dimensions == 1024


def test_the_batch_size_comes_from_configuration() -> None:
    router = EmbeddingRouter.configured(
        settings_with(llm_provider="ollama", embedding_batch_size=3)
    )

    assert router is not None
    assert [batch for _offset, batch in router.batches(["a", "b", "c", "d"])] == [
        ["a", "b", "c"],
        ["d"],
    ]


# ── Tokenizing ───────────────────────────────────────────────────────────────


def test_the_token_count_comes_from_the_configured_model() -> None:
    # A character count is out by a factor of four in English and out
    # differently in Turkish, and the chunker's band is measured in tokens.
    tokenizer = Tokenizer("text-embedding-3-large")

    assert tokenizer.count("Revenue grew 18% year over year.") > 0
    assert tokenizer.count("") == 0


def test_an_unknown_model_still_produces_a_usable_estimate() -> None:
    """A private vLLM fine-tune has no tokenizer LiteLLM knows.

    The fallback is an estimate and is used as one: the point is that the
    chunker produces chunks of roughly the right size rather than no chunks.
    """
    tokenizer = Tokenizer("hosted_vllm/somebody/private-finetune-v3")

    assert tokenizer.count("Revenue grew 18% year over year.") > 0


def test_truncation_lands_on_a_word_boundary() -> None:
    tokenizer = Tokenizer("text-embedding-3-large")
    text = " ".join(f"word{index}" for index in range(500))

    truncated = tokenizer.truncate(text, 40)

    assert tokenizer.count(truncated) <= 40
    assert text.startswith(truncated)
    # Not cut inside a word: a fragment is neither a word in the document nor
    # searchable.
    assert truncated.split()[-1] in text.split()


# ── Retries and the breaker ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_rate_limit_is_retried_and_a_bad_credential_is_not() -> None:
    attempts: list[int] = []

    async def rate_limited(attempt: int) -> str:
        attempts.append(attempt)
        if attempt < 3:
            raise ModelCallError("429", role="embedding", retryable=True, status=429)
        return "ok"

    result = await with_resilience(
        rate_limited, role="embedding", attempts=3, sleep=_no_sleep, jitter=lambda: 0.0
    )
    assert result == "ok"
    assert attempts == [1, 2, 3]

    rejected: list[int] = []

    async def unauthorized(attempt: int) -> str:
        rejected.append(attempt)
        raise ModelCallError("401", role="embedding", retryable=False, status=401)

    with pytest.raises(ModelCallError):
        await with_resilience(
            unauthorized, role="embedding", attempts=3, sleep=_no_sleep, jitter=lambda: 0.0
        )
    assert rejected == [1]


def test_status_classification() -> None:
    assert is_retryable_status(429) is True
    assert is_retryable_status(503) is True
    assert is_retryable_status(400) is False
    assert is_retryable_status(401) is False


@pytest.mark.asyncio
async def test_the_backoff_is_exponential_with_full_jitter() -> None:
    waits: list[float] = []

    async def record(ms: float) -> None:
        waits.append(ms)

    async def always_fails(_attempt: int) -> str:
        raise ModelCallError("503", role="embedding", retryable=True, status=503)

    with pytest.raises(ModelCallError):
        await with_resilience(
            always_fails,
            role="embedding",
            attempts=4,
            base_delay_seconds=0.1,
            sleep=record,
            # Pinned to its maximum, so the assertion is about the exponential
            # rather than about the draw.
            jitter=lambda: 1.0,
        )

    assert waits == pytest.approx([0.1, 0.2, 0.4])


@pytest.mark.asyncio
async def test_three_attempts_against_one_dead_provider_are_one_failure() -> None:
    """What stops a queue of a hundred documents discovering one outage a
    hundred times — and what stops the circuit opening on the first job."""
    clock = [0.0]
    breaker = CircuitBreaker(failures=2, cooldown_seconds=10.0, clock=lambda: clock[0])

    async def always_fails(_attempt: int) -> str:
        raise ModelCallError("503", role="embedding", retryable=True, status=503)

    async def run() -> None:
        await with_resilience(
            always_fails,
            role="embedding",
            attempts=3,
            breaker=breaker,
            sleep=_no_sleep,
            jitter=lambda: 0.0,
        )

    with pytest.raises(ModelCallError):
        await run()
    assert breaker.state == "closed"

    with pytest.raises(ModelCallError):
        await run()
    assert breaker.state == "open"

    # Open: refused instantly, without touching the provider.
    with pytest.raises(CircuitOpenError):
        await run()


@pytest.mark.asyncio
async def test_a_malformed_request_does_not_take_a_healthy_provider_offline() -> None:
    breaker = CircuitBreaker(failures=2, cooldown_seconds=10.0, clock=lambda: 0.0)

    async def bad_request(_attempt: int) -> str:
        raise ModelCallError("400", role="embedding", retryable=False, status=400)

    for _ in range(5):
        with pytest.raises(ModelCallError):
            await with_resilience(
                bad_request,
                role="embedding",
                attempts=3,
                breaker=breaker,
                sleep=_no_sleep,
                jitter=lambda: 0.0,
            )

    assert breaker.state == "closed"


@pytest.mark.asyncio
async def test_one_call_is_let_through_after_the_cooldown() -> None:
    clock = [0.0]
    breaker = CircuitBreaker(failures=1, cooldown_seconds=5.0, clock=lambda: clock[0])
    breaker.record_failure()
    assert breaker.state == "open"

    clock[0] = 6.0
    result = await with_resilience(
        lambda _attempt: _ok(), role="embedding", attempts=1, breaker=breaker
    )

    assert result == "ok"
    assert breaker.state == "closed"


async def _no_sleep(_seconds: float) -> None:
    return None


async def _ok() -> str:
    return "ok"
