"""Counting tokens the way the configured embedding model counts them.

The chunker's whole job is to produce passages of a particular size, and "size"
has to mean what the embedding model means by it. A character count is out by a
factor of three or four; a word count is out by less but is out differently for
English and for Turkish, and this product is explicitly multilingual. So the
count goes through the router, which is the one thing that knows what model is
configured.

LiteLLM resolves the right tokenizer per model: ``tiktoken`` for the OpenAI
families, the model's own HuggingFace tokenizer for the ones it has a mapping
for. Where it has neither — a private vLLM deployment of somebody's fine-tune —
it falls back to ``cl100k_base``, and this module falls back further to a
heuristic if even that is unavailable. Each step down is logged once, because a
chunker silently measuring in the wrong units produces an index that is subtly
worse in a way no test would notice.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from functools import lru_cache

from konusbitr_worker.log import get_logger

__all__ = ["Tokenizer"]

logger = get_logger("konusbitr.worker.ai.tokens")

#: Characters per token when nothing better is available.
#:
#: Four is the usual English figure for byte-pair encodings. It is an estimate
#: and is used as one: the fallback exists so that an unrecognised model
#: produces chunks of roughly the right size rather than no chunks at all.
_FALLBACK_CHARS_PER_TOKEN = 4

_WHITESPACE = re.compile(r"\s+")


class Tokenizer:
    """Token counts for one model, memoized.

    One instance per model name, held for the life of a job. Counting is called
    once per element and several times per chunk boundary — a 500-page document
    is tens of thousands of calls — so the import and the tokenizer lookup
    happen once rather than per call.
    """

    def __init__(self, model: str | None) -> None:
        self._model = model
        self._counter = _counter_for(model)

    @property
    def model(self) -> str | None:
        return self._model

    def count(self, text: str) -> int:
        if not text:
            return 0
        return self._counter(text)

    def truncate(self, text: str, limit: int) -> str:
        """Cut ``text`` to at most ``limit`` tokens, on a whitespace boundary.

        Binary search over word boundaries rather than over the token ids
        directly: the tokenizer this class wraps counts but does not
        necessarily decode — LiteLLM's interface is a count — and a cut made
        inside a word would leave a fragment that is neither a word in the
        document nor searchable.
        """
        if self.count(text) <= limit:
            return text

        words = text.split(" ")
        low, high = 0, len(words)
        while low < high:
            middle = (low + high + 1) // 2
            if self.count(" ".join(words[:middle])) <= limit:
                low = middle
            else:
                high = middle - 1
        return " ".join(words[:low])


def _counter_for(model: str | None) -> Callable[[str], int]:
    if model is None:
        return _heuristic_count

    try:
        from litellm import token_counter
    except Exception:  # pragma: no cover - litellm is a hard dependency
        logger.warning("litellm is unavailable; falling back to a heuristic token count")
        return _heuristic_count

    def count(text: str) -> int:
        try:
            return int(token_counter(model=model, text=text))
        except Exception:
            # LiteLLM raises for a model it has no tokenizer mapping for, which
            # is the normal case for a private vLLM deployment. Warn once —
            # `_warn_once` is memoized on the model name — and keep going.
            _warn_once(model)
            return _heuristic_count(text)

    return count


@lru_cache(maxsize=32)
def _warn_once(model: str) -> None:
    logger.warning(
        "no tokenizer for this embedding model; chunk sizes are estimated",
        extra={"model": model},
    )


def _heuristic_count(text: str) -> int:
    """Roughly how many tokens a byte-pair encoder would make of this.

    The maximum of a character estimate and a whitespace-token count, because
    the two fail in opposite directions: the character estimate undercounts
    agglutinative languages where one word is many tokens, and the word count
    undercounts text that is mostly punctuation or numbers.
    """
    stripped = _WHITESPACE.sub(" ", text).strip()
    if not stripped:
        return 0
    return max(len(stripped) // _FALLBACK_CHARS_PER_TOKEN, stripped.count(" ") + 1)
