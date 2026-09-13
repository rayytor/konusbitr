"""The model router: one interface to every provider, and the offline promise.

Konusbitr never imports a provider SDK. Every model call the pipeline makes
goes through `LiteLLM <https://github.com/BerriAI/litellm>`_, whose four roles
— chat, embedding, rerank, vision — are configured independently, because the
deployments this project exists for genuinely mix them: a law firm runs a cloud
chat model and keeps embeddings local so document text never leaves the
building, and a government install runs everything local. Neither shape is
expressible if the provider is an import.

The TypeScript half of the same contract is ``packages/ai``. The two share their
vocabulary — role names, the local/cloud partition, the environment variables —
through ``konusbitr_worker.settings`` and ``packages/shared``, so an operator
configures one ``.env`` and both halves agree about what it said.

Nothing here is imported at module scope by :mod:`konusbitr_worker.settings`.
LiteLLM is a heavy import — it drags in ``openai``, ``tiktoken`` and a tokenizer
stack — and settings has to be importable before code generation has run and
inside a container health probe that has no business loading a model registry.
"""

from __future__ import annotations

from konusbitr_worker.ai.chat import ChatModel, ChatRouter, resolve_chat_model
from konusbitr_worker.ai.embeddings import (
    EmbeddingDimensionError,
    EmbeddingRouter,
    ModelNotConfiguredError,
)
from konusbitr_worker.ai.offline import OfflineModeError, is_local_endpoint
from konusbitr_worker.ai.resilience import CircuitBreaker, CircuitOpenError, ModelCallError
from konusbitr_worker.ai.tokens import Tokenizer
from konusbitr_worker.ai.usage import UsageRecord

__all__ = [
    "ChatModel",
    "ChatRouter",
    "CircuitBreaker",
    "CircuitOpenError",
    "EmbeddingDimensionError",
    "EmbeddingRouter",
    "ModelCallError",
    "ModelNotConfiguredError",
    "OfflineModeError",
    "Tokenizer",
    "UsageRecord",
    "is_local_endpoint",
    "resolve_chat_model",
]
