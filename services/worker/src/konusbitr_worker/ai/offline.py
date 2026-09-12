"""Offline mode, enforced at the call site.

:mod:`konusbitr_worker.settings` already refuses to start a process whose
configuration names a cloud provider while ``OFFLINE_MODE=true``. This is the
second enforcement, and it is not redundant: configuration can change under a
running process, and a guarantee that lapses at the next deploy is not the
guarantee legal, medical and government users installed this software for.

The failure is loud and immediate, before any bytes have been assembled into a
request body. Nothing is retried, nothing is degraded, and nothing falls back to
a cloud endpoint — the whole point is that the document does not leave.
"""

from __future__ import annotations

from konusbitr_worker.settings import LOCAL_PROVIDERS, LlmProvider, Settings
from konusbitr_worker.settings import is_local_endpoint as _is_local_endpoint

__all__ = ["OfflineModeError", "assert_reachable", "is_local_endpoint"]


class OfflineModeError(RuntimeError):
    """Raised when a call would reach an endpoint offline mode forbids."""

    def __init__(self, provider: LlmProvider, endpoint: str) -> None:
        super().__init__(
            f"OFFLINE_MODE is on and {provider} at {endpoint} is not a local endpoint. "
            f"Configure {' or '.join(LOCAL_PROVIDERS)} instead. Refusing the call "
            "rather than sending document text off this machine."
        )
        self.provider = provider
        self.endpoint = endpoint


def is_local_endpoint(value: str) -> bool:
    """Whether a URL points at this machine or this network.

    Re-exported from :mod:`konusbitr_worker.settings`, where the boot check
    needs the same predicate. One definition, so that a deployment cannot pass
    the boot check and fail the call check or the reverse.
    """
    return _is_local_endpoint(value)


def assert_reachable(settings: Settings, provider: LlmProvider, endpoint: str | None) -> None:
    """Raise unless this endpoint may be called under the current configuration.

    Both halves have to hold: the provider must be one Konusbitr calls local,
    *and* the URL it resolved to must actually be a local address. Checking only
    the provider would let ``OLLAMA_BASE_URL=https://ollama.someones-cloud.com``
    through, which is a cloud call wearing a local provider's name.

    ``endpoint`` may be ``None`` for a provider whose address LiteLLM knows
    without being told — which is only ever a cloud provider, so under offline
    mode that is a refusal too.
    """
    if not settings.offline_mode:
        return
    if provider in LOCAL_PROVIDERS and endpoint is not None and is_local_endpoint(endpoint):
        return
    raise OfflineModeError(provider, endpoint or "its default endpoint")
