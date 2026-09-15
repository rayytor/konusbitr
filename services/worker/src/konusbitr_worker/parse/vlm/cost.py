"""The advanced tier's cost arithmetic, mirrored from the TypeScript half.

``packages/shared/src/vlm.ts`` is the source of truth; this is the same
arithmetic in Python. It is hand-mirrored rather than generated because it never
crosses the Redis seam as a *message* — the estimate is computed on the product
surface, shown to a person, and then the job is created — but both halves must
agree, because the number a reader confirmed and the number an operator later
reconciles against the usage log have to be the same number.
``tests/test_vlm_cost.py`` pins the two together by reading the TypeScript
constants out of the file.

The worker needs this for one thing the web app cannot do: refusing a job whose
page count exceeds the ceiling. A payload arrives from a queue, not from the
endpoint that validated it, so the ceiling is enforced in both places.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

from konusbitr_worker.settings import LOCAL_PROVIDERS, LlmProvider

__all__ = [
    "FALLBACK_PRICE",
    "PIXELS_PER_IMAGE_TOKEN",
    "VLM_COMPLETION_TOKENS_PER_PAGE",
    "VLM_IMAGE_MAX_EDGE",
    "VLM_MODEL_PRICES",
    "VLM_PROMPT_TOKENS",
    "VLM_SECONDS_PER_PAGE",
    "VlmCostEstimate",
    "estimate_vlm_cost",
    "image_tokens_per_page",
]

#: Longest edge, in pixels, a page image is resampled to before it is sent.
VLM_IMAGE_MAX_EDGE = 1568

#: Square pixels per image token. Anthropic's published `width * height / 750`; OpenAI's
#: tiling and Google's fixed tiles land within about a third of it for a
#: page-shaped image, which is the honest resolution of an "up to" estimate.
PIXELS_PER_IMAGE_TOKEN = 750

#: The instruction turn: `vlm.parse.v1` plus the schema it specifies.
VLM_PROMPT_TOKENS = 420

#: Output tokens budgeted for one page, and the `max_tokens` actually sent — so
#: a page cannot cost more than the estimate said it would.
VLM_COMPLETION_TOKENS_PER_PAGE = 1500

#: Wall-clock seconds one page's inference takes, for the latency estimate.
VLM_SECONDS_PER_PAGE = 6

#: USD per million tokens, as `(prompt, completion)`, keyed by the model name
#: the router resolves. Mirrors `VLM_MODEL_PRICES` in the TypeScript half.
VLM_MODEL_PRICES: dict[str, tuple[float, float]] = {
    "claude-sonnet-4-5": (3.0, 15.0),
    "claude-3-7-sonnet-latest": (3.0, 15.0),
    "claude-3-5-sonnet-latest": (3.0, 15.0),
    "gpt-4.1-mini": (0.4, 1.6),
    "gpt-4.1": (2.0, 8.0),
    "gpt-4o": (2.5, 10.0),
    "gpt-4o-mini": (0.15, 0.6),
    "gemini/gemini-2.5-flash": (0.3, 2.5),
    "gemini/gemini-2.0-flash": (0.1, 0.4),
    "pixtral-12b-2409": (0.15, 0.15),
}

#: What an unlisted cloud model is priced at. Deliberately not cheap.
FALLBACK_PRICE: tuple[float, float] = (3.0, 15.0)

PricedFrom = Literal["table", "fallback", "operator", "local"]


@dataclass(frozen=True, slots=True)
class VlmCostEstimate:
    pages: int
    prompt_tokens: int
    completion_tokens: int
    #: ``None`` for a local model. Not zero: "no charge" and "we could not
    #: price it" render identically as `0` and mean opposite things.
    estimated_usd: float | None
    estimated_seconds: int
    priced_from: PricedFrom
    model: str

    def to_json(self) -> dict[str, object]:
        return {
            "pages": self.pages,
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "estimatedUsd": self.estimated_usd,
            "estimatedSeconds": self.estimated_seconds,
            "pricedFrom": self.priced_from,
            "model": self.model,
        }


def image_tokens_per_page(dpi: float = 180.0) -> int:
    """Image tokens for one Letter page rendered at `dpi` and resampled to fit.

    A Letter page is the unit because the resample cap, not the paper size,
    decides what a model actually sees. At the default 180 DPI a Letter page
    renders to 1530 x 1980, is already past the cap on its long edge, and
    arrives at the model as 1211 x 1568 — and so does an A0 poster. Charging for
    the render rather than for the resample would over-estimate every page by a
    factor of 1.6, for pixels the provider discards before it looks.
    """
    width = 8.5 * dpi
    height = 11.0 * dpi
    scale = min(1.0, VLM_IMAGE_MAX_EDGE / max(width, height))
    return math.ceil(((width * scale) * (height * scale)) / PIXELS_PER_IMAGE_TOKEN)


def estimate_vlm_cost(
    *,
    page_count: int,
    model: str,
    provider: LlmProvider,
    dpi: float = 180.0,
    concurrency: int = 3,
    usd_per_page_override: float | None = None,
) -> VlmCostEstimate:
    """What reading `page_count` pages with a vision model would cost."""
    pages = max(0, int(page_count))
    per_page_image = image_tokens_per_page(dpi)

    prompt_tokens = pages * (per_page_image + VLM_PROMPT_TOKENS)
    completion_tokens = pages * VLM_COMPLETION_TOKENS_PER_PAGE
    estimated_seconds = math.ceil((pages / max(1, concurrency)) * VLM_SECONDS_PER_PAGE)

    if provider in LOCAL_PROVIDERS:
        return VlmCostEstimate(
            pages=pages,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            estimated_usd=None,
            estimated_seconds=estimated_seconds,
            priced_from="local",
            model=model,
        )

    if usd_per_page_override is not None and usd_per_page_override >= 0:
        return VlmCostEstimate(
            pages=pages,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            estimated_usd=round(pages * usd_per_page_override, 6),
            estimated_seconds=estimated_seconds,
            priced_from="operator",
            model=model,
        )

    listed = VLM_MODEL_PRICES.get(model)
    prompt_price, completion_price = listed or FALLBACK_PRICE
    estimated_usd = round(
        (prompt_tokens / 1_000_000) * prompt_price
        + (completion_tokens / 1_000_000) * completion_price,
        6,
    )

    return VlmCostEstimate(
        pages=pages,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        estimated_usd=estimated_usd,
        estimated_seconds=estimated_seconds,
        priced_from="table" if listed else "fallback",
        model=model,
    )
