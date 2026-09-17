"""The cost estimate, and the parity between its two implementations.

`packages/shared/src/vlm.ts` computes the number a person is shown before they
agree to an advanced parse; `konusbitr_worker.parse.vlm.cost` computes the same
number on the other side of the queue. They are hand-mirrored, because this
never crosses the Redis seam as a message and so is not generated — which means
nothing but a test stops them drifting.

The drift that matters is not cosmetic. If the two disagree, the figure somebody
confirmed and the figure an operator later reconciles against the usage log are
different figures, and the monthly cap is enforced against a number nobody was
shown. So the parity test below reads the constants **out of the TypeScript
source** rather than restating them here: a copy of the numbers in this file
would be a third place to drift.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from konusbitr_worker.parse.vlm.cost import (
    FALLBACK_PRICE,
    PIXELS_PER_IMAGE_TOKEN,
    VLM_COMPLETION_TOKENS_PER_PAGE,
    VLM_IMAGE_MAX_EDGE,
    VLM_MODEL_PRICES,
    VLM_PROMPT_TOKENS,
    VLM_SECONDS_PER_PAGE,
    estimate_vlm_cost,
    image_tokens_per_page,
)

TYPESCRIPT = Path(__file__).resolve().parents[3] / "packages" / "shared" / "src" / "vlm.ts"


def typescript_source() -> str:
    if not TYPESCRIPT.is_file():  # pragma: no cover - a broken checkout
        pytest.skip(f"the TypeScript half is missing from {TYPESCRIPT}")
    return TYPESCRIPT.read_text(encoding="utf-8")


def constant(source: str, name: str) -> float:
    match = re.search(rf"export const {name} = ([0-9.]+);", source)
    assert match is not None, f"{name} is not exported from vlm.ts"
    return float(match.group(1))


class TestParityWithTypeScript:
    """Every constant the two halves share, pinned against the other's source."""

    @pytest.mark.parametrize(
        ("name", "value"),
        [
            ("VLM_IMAGE_MAX_EDGE", VLM_IMAGE_MAX_EDGE),
            ("PIXELS_PER_IMAGE_TOKEN", PIXELS_PER_IMAGE_TOKEN),
            ("VLM_PROMPT_TOKENS", VLM_PROMPT_TOKENS),
            ("VLM_COMPLETION_TOKENS_PER_PAGE", VLM_COMPLETION_TOKENS_PER_PAGE),
            ("VLM_SECONDS_PER_PAGE", VLM_SECONDS_PER_PAGE),
        ],
    )
    def test_a_shared_constant_matches(self, name: str, value: float) -> None:
        assert constant(typescript_source(), name) == value

    def test_the_price_table_names_the_same_models(self) -> None:
        """A model priced on one side and absent on the other is the drift that
        matters most: the browser quotes a rate and the cap is enforced against
        the fallback, or the reverse."""
        source = typescript_source()
        block = source[source.index("VLM_MODEL_PRICES") :]
        block = block[: block.index("});")]

        listed = set(re.findall(r"'([^']+)': \[", block))
        assert listed == set(VLM_MODEL_PRICES)

    def test_the_fallback_price_matches(self) -> None:
        source = typescript_source()
        match = re.search(r"FALLBACK_PRICE: readonly \[number, number\] = \[(\d+), (\d+)\]", source)
        assert match is not None
        assert (float(match.group(1)), float(match.group(2))) == FALLBACK_PRICE

    def test_the_ceiling_and_the_threshold_match(self) -> None:
        source = typescript_source()
        assert constant(source, "DEFAULT_MAX_VLM_PAGES_PER_JOB") == 50
        assert constant(source, "DEFAULT_TIER_FALLBACK_THRESHOLD") == 0.6
        assert constant(source, "DEFAULT_VLM_DPI") == 180


class TestImageTokens:
    def test_a_letter_page_at_the_default_dpi_is_resampled_first(self) -> None:
        """8.5 x 11 at 180 DPI is 1530 x 1980, whose long edge is past the cap.

        So the page a model actually looks at is 1211 x 1568, and the estimate
        is over *that* — which is the arithmetic being pinned. Charging for the
        1980-pixel render would over-estimate by a factor of 1.6 for pixels the
        provider discards before it looks.
        """
        scale = VLM_IMAGE_MAX_EDGE / 1980
        expected = (1530 * scale) * (1980 * scale) / PIXELS_PER_IMAGE_TOKEN
        assert image_tokens_per_page(180) == pytest.approx(expected, rel=0.01)

    def test_a_small_page_is_not_upscaled(self) -> None:
        """Below the cap the render is what is sent, so halving the DPI really
        does quarter the tokens. The cap is a ceiling, not a target."""
        assert image_tokens_per_page(72) < image_tokens_per_page(120)

    def test_a_page_past_the_cap_is_resampled_rather_than_charged_for(self) -> None:
        """The cap is what makes the estimate a function of the page *count*:
        doubling the DPI must not double the tokens once the long edge is past
        1568px, because the provider resamples before it looks."""
        assert image_tokens_per_page(400) == image_tokens_per_page(300)


class TestEstimates:
    def test_a_cloud_model_is_priced_from_the_table(self) -> None:
        estimate = estimate_vlm_cost(page_count=10, model="gpt-4.1-mini", provider="openai")
        assert estimate.priced_from == "table"
        assert estimate.estimated_usd is not None
        assert estimate.estimated_usd > 0

    def test_an_unlisted_model_says_its_price_was_a_guess(self) -> None:
        """A confident `$0.00` for an unknown model is worse than an admitted
        guess, so the fallback is deliberately not cheap and says so."""
        estimate = estimate_vlm_cost(
            page_count=10, model="some-new-frontier-model", provider="openai"
        )
        assert estimate.priced_from == "fallback"
        assert estimate.estimated_usd is not None

    def test_a_local_model_is_priced_null_rather_than_zero(self) -> None:
        """ "No charge" and "we could not work it out" render identically as
        `$0.00` and mean opposite things to somebody deciding whether to press
        a button."""
        estimate = estimate_vlm_cost(page_count=10, model="ollama/qwen2.5vl:7b", provider="ollama")
        assert estimate.priced_from == "local"
        assert estimate.estimated_usd is None

    def test_an_operator_override_wins_over_the_table(self) -> None:
        estimate = estimate_vlm_cost(
            page_count=10,
            model="gpt-4.1-mini",
            provider="openai",
            usd_per_page_override=0.02,
        )
        assert estimate.priced_from == "operator"
        assert estimate.estimated_usd == pytest.approx(0.2)

    def test_cost_scales_with_pages(self) -> None:
        one = estimate_vlm_cost(page_count=1, model="gpt-4o", provider="openai")
        ten = estimate_vlm_cost(page_count=10, model="gpt-4o", provider="openai")
        assert one.estimated_usd is not None and ten.estimated_usd is not None
        assert ten.estimated_usd == pytest.approx(one.estimated_usd * 10, rel=1e-6)

    def test_zero_pages_costs_nothing(self) -> None:
        estimate = estimate_vlm_cost(page_count=0, model="gpt-4o", provider="openai")
        assert estimate.estimated_usd == 0
        assert estimate.prompt_tokens == 0

    def test_latency_accounts_for_concurrency(self) -> None:
        serial = estimate_vlm_cost(page_count=12, model="gpt-4o", provider="openai", concurrency=1)
        parallel = estimate_vlm_cost(
            page_count=12, model="gpt-4o", provider="openai", concurrency=3
        )
        assert parallel.estimated_seconds < serial.estimated_seconds
