"""Who gets looked at, what it costs, and what happens when it goes wrong.

The tier's model calls are stubbed throughout. What is under test here is not
whether a vision model can read a page — that is a property of the model — but
the decisions around it, which are ours and which all have money or a refusal on
the other side of them:

- which pages are sent,
- when a document is refused outright,
- that `OFFLINE_MODE` reaches no cloud endpoint,
- that a page the model failed on keeps the reading another tier produced.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from konusbitr_worker.ai.embeddings import ModelNotConfiguredError
from konusbitr_worker.ai.vision import VisionRouter, resolve_vision_model
from konusbitr_worker.contracts import JobErrorCode
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.parse import (
    _looker,
    _pages_to_look_at,
    _require_within_vlm_budget,
    _tier_of,
    _vlm_options,
)
from konusbitr_worker.parse.artifact import PageTier
from konusbitr_worker.parse.geometry import PageGeometry
from konusbitr_worker.parse.inspect import DocumentInspection
from konusbitr_worker.parse.ocr import OcrPageResult
from konusbitr_worker.parse.vlm import VlmOptions, read_pages
from konusbitr_worker.settings import Settings
from tests.factories import BASE_ENV


def inspection(pages: int) -> DocumentInspection:
    geometries = [
        PageGeometry(page_no=index + 1, raw_width=612.0, raw_height=792.0) for index in range(pages)
    ]
    return DocumentInspection(
        page_count=pages,
        pages=geometries,
        coverage=[1.0] * pages,
        tiers=[PageTier.native] * pages,
    )


def recognised(*confidences: float) -> list[OcrPageResult]:
    return [
        OcrPageResult(page_no=index + 1, confidence=confidence)
        for index, confidence in enumerate(confidences)
    ]


def configured(**overrides) -> Settings:
    """Settings with a vision role that resolves, so the tier can be built."""
    return Settings(
        _env_file=None,
        llm_provider="openai",
        llm_api_key="sk-test",
        **{**BASE_ENV, **overrides},
    )


class TestTheCeiling:
    def test_a_long_document_is_refused_rather_than_truncated(self) -> None:
        """A parse that reads fifty pages of a four-hundred-page filing has spent
        the money the ceiling was meant to save *and* produced a document
        silently missing seven eighths of itself."""
        with pytest.raises(JobFailure) as raised:
            _require_within_vlm_budget(inspection(400), configured(), advanced=True)

        assert raised.value.code is JobErrorCode.too_many_pages

    def test_the_refusal_is_terminal(self) -> None:
        """No number of retries makes a document shorter, and burning three
        attempts on it delays every other job in the queue."""
        from konusbitr_worker.contracts import TERMINAL_JOB_ERROR_CODES

        assert JobErrorCode.too_many_pages.value in {
            code.value if hasattr(code, "value") else code for code in TERMINAL_JOB_ERROR_CODES
        }

    def test_a_document_at_the_ceiling_is_allowed(self) -> None:
        _require_within_vlm_budget(inspection(50), configured(), advanced=True)

    def test_a_standard_parse_is_never_refused_for_length(self) -> None:
        """The ceiling is about what a vision model costs, and a standard parse
        does not call one. `MAX_PAGES` is the unrelated knob for document length."""
        _require_within_vlm_budget(inspection(4000), configured(), advanced=False)

    def test_the_ceiling_is_configurable(self) -> None:
        with pytest.raises(JobFailure):
            _require_within_vlm_budget(
                inspection(11), configured(max_vlm_pages_per_job=10), advanced=True
            )


class TestPageSelection:
    def test_advanced_reads_every_page(self) -> None:
        """What is bought is *document-level* structure — a heading hierarchy
        that holds from the first page to the last — and reading a subset
        produces a document whose section paths change tier half way through."""
        pages = _pages_to_look_at(inspection(8), [], configured(), advanced=True, enabled=True)
        assert pages == list(range(1, 9))

    def test_a_standard_parse_escalates_only_badly_read_pages(self) -> None:
        pages = _pages_to_look_at(
            inspection(4),
            recognised(0.95, 0.42, 0.88, 0.31),
            configured(),
            advanced=False,
            enabled=True,
        )
        assert pages == [2, 4]

    def test_escalation_is_capped_rather_than_refused(self) -> None:
        """Nobody asked for this and nobody is waiting to confirm a price, so a
        filing with two hundred illegible pages gets its best fifty rather than
        an error — the opposite of the rule for an explicit `advanced` request,
        for the opposite reason."""
        pages = _pages_to_look_at(
            inspection(200),
            recognised(*([0.2] * 200)),
            configured(max_vlm_pages_per_job=50),
            advanced=False,
            enabled=True,
        )
        assert len(pages) == 50

    def test_a_zero_threshold_switches_escalation_off(self) -> None:
        pages = _pages_to_look_at(
            inspection(4),
            recognised(0.1, 0.1, 0.1, 0.1),
            configured(tier_fallback_threshold=0.0),
            advanced=False,
            enabled=True,
        )
        assert pages == []

    def test_a_well_read_scan_is_not_escalated(self) -> None:
        pages = _pages_to_look_at(
            inspection(3),
            recognised(0.91, 0.88, 0.97),
            configured(),
            advanced=False,
            enabled=True,
        )
        assert pages == []

    def test_nothing_is_selected_when_the_tier_cannot_run(self) -> None:
        pages = _pages_to_look_at(inspection(8), [], configured(), advanced=True, enabled=False)
        assert pages == []

    def test_the_threshold_sits_below_the_viewers_warning(self) -> None:
        """The two numbers do different things: one badges a page for a reader,
        the other spends money. Pinned because a future tidy-up that unified
        them would quietly make every slightly-imperfect page a model call."""
        settings = configured()
        assert settings.tier_fallback_threshold < settings.ocr_low_confidence_threshold


class TestWhetherTheTierRunsAtAll:
    def test_it_is_off_when_the_operator_switched_it_off(self) -> None:
        assert _looker(configured(vlm_enabled=False), quality="advanced") is None

    def test_no_router_is_built_when_nothing_could_use_it(self) -> None:
        """A standard parse with escalation disabled has no page to send, and
        building a router would resolve a model and open a circuit breaker for
        nothing."""
        settings = configured(tier_fallback_threshold=0.0)
        assert _looker(settings, quality="standard") is None

    def test_an_unconfigured_vision_role_degrades_rather_than_failing(self) -> None:
        """Intake refuses `advanced` when no vision role is configured, so
        reaching here means the configuration changed between the upload and the
        job. Losing the document over that would be the wrong trade."""
        settings = Settings(_env_file=None, **BASE_ENV)
        assert _looker(settings, quality="advanced") is None

    def test_a_configured_role_builds_the_router(self) -> None:
        assert _looker(configured(), quality="advanced") is not None


class TestOffline:
    def test_a_cloud_vision_provider_fails_the_process_at_boot(self) -> None:
        """Enforced at boot *and* at the call site, because configuration can
        change under a running process and a guarantee that lapses at the next
        deploy is not a guarantee."""
        with pytest.raises(Exception) as raised:
            Settings(
                _env_file=None,
                offline_mode=True,
                llm_provider="ollama",
                vision_provider="openai",
                **BASE_ENV,
            )
        assert "OFFLINE_MODE" in str(raised.value)

    def test_offline_resolves_to_the_local_vision_model(self) -> None:
        """Qwen2.5-VL rather than a description-only model: reading a page into
        structured elements needs coordinates back, and an element with no box
        cannot be cited."""
        settings = Settings(
            _env_file=None,
            offline_mode=True,
            llm_provider="ollama",
            **BASE_ENV,
        )
        model = resolve_vision_model(settings)
        assert model.provider == "ollama"
        assert "qwen" in model.name.lower()
        assert model.api_base is not None
        assert "localhost" in model.api_base or "ollama" in model.api_base

    def test_the_advanced_tier_is_available_offline(self) -> None:
        settings = Settings(
            _env_file=None,
            offline_mode=True,
            llm_provider="ollama",
            **BASE_ENV,
        )
        assert _looker(settings, quality="advanced") is not None


class TestTierRecording:
    def test_a_page_the_model_read_is_recorded_as_vlm(self) -> None:
        """However it was tiered before: that is the reading that survived into
        `contents`, and recording anything else would badge a page in the viewer
        as something no tier produced."""
        assert _tier_of(3, looked={3}, recognized=set()) is PageTier.vlm

    def test_the_vlm_tier_wins_over_a_recognised_page(self) -> None:
        assert _tier_of(3, looked={3}, recognized={3}) is PageTier.vlm

    def test_an_untouched_page_stays_native(self) -> None:
        assert _tier_of(1, looked={3}, recognized={2}) is PageTier.native


class FakeRouter:
    """A vision router that answers from a script. Never reaches a provider."""

    model_name = "fake-vision"

    def __init__(self, answers: dict[int, str] | None = None, *, fail: bool = False) -> None:
        self.answers = answers or {}
        self.fail = fail
        self.calls = 0

    async def read_page(self, *, system: str, prompt: str, image: bytes, **_) -> str:
        self.calls += 1
        if self.fail:
            raise RuntimeError("the provider is unavailable")
        return self.answers.get(self.calls, '{"elements": []}')


def page_answer(text: str) -> str:
    return json.dumps(
        {
            "elements": [
                {
                    "type": "paragraph",
                    "text": text,
                    "markdown": text,
                    "bbox_normalized": [100, 50, 200, 900],
                    "reading_order": 1,
                }
            ]
        }
    )


class TestReading:
    @pytest.mark.asyncio
    async def test_a_page_is_read_and_reconciled(self, fixtures_dir: Path) -> None:
        path = fixtures_dir / "clean-text-10p.pdf"
        from konusbitr_worker.parse.inspect import inspect_pdf
        from konusbitr_worker.parse.textlayer import page_words

        found = inspect_pdf(path, ocr_available=True)
        geometries = {page.page_no: page for page in found.pages}
        truth = page_words(path, [1], geometries=geometries)

        # A transcription with a plausible error in it, covering the top strip
        # of the page where the fixture's heading sits.
        model_text = " ".join(word.text for word in truth[1][:8])
        broken = model_text.replace("e", "e", 1) + " INVENTED"

        router = FakeRouter({1: page_answer(broken)})
        results = await read_pages(
            path,
            [1],
            geometries=geometries,
            truth=truth,
            router=router,  # type: ignore[arg-type]
            options=VlmOptions(dpi=72, concurrency=1),
        )

        assert len(results) == 1
        assert results[0].elements
        assert results[0].report.elements == 1

    @pytest.mark.asyncio
    async def test_a_provider_failure_marks_the_page_and_does_not_raise(
        self, fixtures_dir: Path
    ) -> None:
        """A page the model could not read still has Docling's or the
        recogniser's reading of it, so an outage degrades the structure of one
        page rather than failing a document."""
        path = fixtures_dir / "clean-text-10p.pdf"
        from konusbitr_worker.parse.inspect import inspect_pdf

        found = inspect_pdf(path, ocr_available=True)
        geometries = {page.page_no: page for page in found.pages}

        results = await read_pages(
            path,
            [1],
            geometries=geometries,
            truth={},
            router=FakeRouter(fail=True),  # type: ignore[arg-type]
            options=VlmOptions(dpi=72, concurrency=1),
        )

        assert results[0].failed is True
        assert results[0].elements == []

    @pytest.mark.asyncio
    async def test_an_empty_answer_is_a_failure_for_merge_purposes(
        self, fixtures_dir: Path
    ) -> None:
        """Not because an empty page is illegitimate — the prompt allows it —
        but because a page with no VLM elements must not supersede the reading
        another tier produced for it."""
        path = fixtures_dir / "clean-text-10p.pdf"
        from konusbitr_worker.parse.inspect import inspect_pdf

        found = inspect_pdf(path, ocr_available=True)
        geometries = {page.page_no: page for page in found.pages}

        results = await read_pages(
            path,
            [1],
            geometries=geometries,
            truth={},
            router=FakeRouter(),  # type: ignore[arg-type]
            options=VlmOptions(dpi=72, concurrency=1),
        )
        assert results[0].failed is True

    @pytest.mark.asyncio
    async def test_no_pages_means_no_calls(self, fixtures_dir: Path) -> None:
        router = FakeRouter()
        results = await read_pages(
            fixtures_dir / "clean-text-10p.pdf",
            [],
            geometries={},
            truth={},
            router=router,  # type: ignore[arg-type]
            options=VlmOptions(),
        )
        assert results == []
        assert router.calls == 0


class TestOptions:
    def test_options_come_from_settings(self) -> None:
        options = _vlm_options(configured(vlm_dpi=200.0, vlm_concurrency=5))
        assert options.dpi == 200.0
        assert options.concurrency == 5

    def test_the_render_dpi_is_lower_than_the_ocr_one(self) -> None:
        """A recogniser needs 30-40 pixels of glyph height; a VLM resamples
        whatever it is given. Sending more than it looks at costs tokens."""
        settings = configured()
        assert settings.vlm_dpi < settings.ocr_dpi

    def test_max_tokens_matches_what_the_estimate_budgeted(self) -> None:
        """So a page cannot cost more than the figure somebody confirmed."""
        from konusbitr_worker.parse.vlm.cost import VLM_COMPLETION_TOKENS_PER_PAGE

        assert configured().vlm_max_tokens == VLM_COMPLETION_TOKENS_PER_PAGE


class TestVisionModelResolution:
    def test_an_unconfigured_role_raises_rather_than_guessing(self) -> None:
        with pytest.raises(ModelNotConfiguredError):
            resolve_vision_model(Settings(_env_file=None, **BASE_ENV))

    def test_configured_returns_none_rather_than_raising(self) -> None:
        """`None` is a supported state and the default of `docker compose up`."""
        assert VisionRouter.configured(Settings(_env_file=None, **BASE_ENV)) is None
