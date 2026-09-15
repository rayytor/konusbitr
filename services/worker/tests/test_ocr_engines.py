"""The two engines, the rule that chooses between them, and the pixel-to-point step.

Two kinds of test here, and they guard different things.

The first kind pins **what the engines are actually configured with**. RapidOCR
accepts arbitrary keyword arguments and silently ignores any whose name does not
match a key in its shipped `config.yaml`, so a typo in an option name is not an
error — it is a setting that quietly does nothing. `max_side_len` in particular
has to be raised from RapidOCR's own default or a 300 DPI page is resampled down
to about 180 before the detector sees it, undoing the single most important
preprocessing decision. That is invisible in the output and would only show up
as slightly worse recognition, so it is asserted against the shipped file.

The second kind is the **fallback rule**, with both engines replaced by doubles.
The rule has three cases and only one of them is the obvious one.
"""

from __future__ import annotations

from typing import Any

import pytest

from konusbitr_worker.parse.geometry import CoordOrigin, PageGeometry
from konusbitr_worker.parse.ocr.engines import (
    OcrResult,
    OcrWord,
    RapidOcrEngine,
    RapidOcrOptions,
    _rapid_word,
    _tesseract_words,
)
from konusbitr_worker.parse.ocr.pipeline import OcrOptions, OcrPipeline
from konusbitr_worker.parse.ocr.raster import POINTS_PER_INCH, RasterPage


class FakeEngine:
    """An engine that returns whatever it was constructed with."""

    def __init__(
        self,
        name: str,
        confidence: float,
        *,
        present: bool = True,
        preparations: tuple[str, ...] = ("image",),
    ) -> None:
        self.name = name
        self.preparations = preparations
        self._confidence = confidence
        self._present = present
        self.calls = 0

    def available(self) -> bool:
        return self._present

    def run(self, image: Any) -> OcrResult:
        self.calls += 1
        # One long token, so the length weighting has nothing to say.
        return OcrResult(
            words=[
                OcrWord(text="a" * 40, box=(0.0, 0.0, 100.0, 20.0), confidence=self._confidence)
            ],
            engine=self.name,
        )


def pipeline(primary: float, fallback: float, **options: Any) -> tuple[OcrPipeline, Any, Any]:
    first = FakeEngine("primary", primary)
    second = FakeEngine("fallback", fallback)
    return (
        OcrPipeline(OcrOptions(**options), primary=first, fallback=second),
        first,
        second,
    )


class TestFallbackRule:
    def test_a_confident_page_never_reaches_the_fallback(self) -> None:
        engine, _first, second = pipeline(0.92, 0.99)

        assert engine.process_page(object()).engine == "primary"
        assert second.calls == 0

    def test_an_unsure_page_is_offered_to_the_fallback(self) -> None:
        engine, _first, second = pipeline(0.40, 0.88)

        assert engine.process_page(object()).engine == "fallback"
        assert second.calls == 1

    def test_the_fallback_is_taken_only_when_it_is_better(self) -> None:
        """An engine reached *because* the primary was unsure has told us something.

        Overwriting a 0.60 page with a 0.31 one because the fallback happened to
        run second is the wrong reading of that: the fallback failing is
        evidence about the page, not about the primary.
        """
        engine, _first, second = pipeline(0.60, 0.31)

        result = engine.process_page(object())
        assert result.engine == "primary"
        assert second.calls == 1

    def test_a_missing_fallback_binary_is_a_supported_state(self) -> None:
        """`tesseract` is a system package; a deployment without one still works."""
        first = FakeEngine("primary", 0.40)
        second = FakeEngine("fallback", 0.99, present=False)
        engine = OcrPipeline(OcrOptions(), primary=first, fallback=second)

        assert engine.process_page(object()).engine == "primary"
        assert second.calls == 0

    def test_the_fallback_can_be_switched_off(self) -> None:
        engine, _first, second = pipeline(0.40, 0.99, fallback_enabled=False)

        assert engine.process_page(object()).engine == "primary"
        assert second.calls == 0

    def test_an_engine_reads_the_image_it_wants_wherever_it_sits(self) -> None:
        """Which image an engine gets follows the *engine*, not the slot.

        Since Phase 12.2 either one can be primary — an Arabic document is read
        by Tesseract first — and a rule written as "the fallback gets the
        binary" would hand the thresholded page to whichever engine happened to
        be second.
        """
        seen: list[tuple[str, object]] = []

        class Recorder(FakeEngine):
            def run(self, image: Any) -> OcrResult:
                seen.append((self.name, image))
                return super().run(image)

        colour, binary = object(), object()

        engine = OcrPipeline(
            OcrOptions(),
            primary=Recorder("rapid-like", 0.10),
            fallback=Recorder("tesseract-like", 0.90, preparations=("binary",)),
        )
        engine.process_page(colour, binary=binary)
        assert seen == [("rapid-like", colour), ("tesseract-like", binary)]

        seen.clear()
        swapped = OcrPipeline(
            OcrOptions(),
            primary=Recorder("tesseract-like", 0.10, preparations=("binary",)),
            fallback=Recorder("rapid-like", 0.90),
        )
        swapped.process_page(colour, binary=binary)
        assert seen == [("tesseract-like", binary), ("rapid-like", colour)]

    def test_an_engine_that_wants_both_preparations_is_read_from_both(self) -> None:
        """Tesseract names two, because neither dominates.

        The Sauvola binarisation is what makes a shadowed photograph readable at
        all, and its window erodes the hairline strokes of connected scripts. The
        two fixtures that prove each half pull in opposite directions, so both
        are read.
        """
        seen: list[object] = []

        class Recorder(FakeEngine):
            def run(self, image: Any) -> OcrResult:
                seen.append(image)
                return super().run(image)

        colour, binary = object(), object()
        engine = OcrPipeline(
            OcrOptions(),
            primary=Recorder("both", 0.95, preparations=("binary", "image")),
            fallback=FakeEngine("unused", 0.99),
        )

        engine.process_page(colour, binary=binary)
        assert seen == [binary, colour]

    def test_the_fuller_reading_wins_when_both_are_confident(self) -> None:
        """The case a confidence comparison cannot see.

        A preparation that loses a whole line is entirely sure about the lines it
        kept: the Arabic fixture's binarised page comes back at 0.92 with half
        its text missing and its greyscale at 0.92 with all of it. Confidence is
        a statement about what *was* recognised and says nothing about what was
        not, so the tie-break is how much was read.
        """

        class Uneven:
            name = "uneven"
            preparations = ("binary", "image")

            def available(self) -> bool:
                return True

            def run(self, image: Any) -> OcrResult:
                text = "half a page" if image == "binary-image" else "the whole of a page of text"
                return OcrResult(
                    words=[OcrWord(text=text, box=(0.0, 0.0, 100.0, 20.0), confidence=0.92)],
                    engine=self.name,
                )

        engine = OcrPipeline(OcrOptions(), primary=Uneven(), fallback=FakeEngine("unused", 0.99))
        result = engine.process_page("colour-image", binary="binary-image")

        assert result.text == "the whole of a page of text"

    def test_a_preparation_below_the_threshold_loses_however_much_it_produced(self) -> None:
        """Volume is the tie-break, not the measure.

        Otherwise a preparation that turns a page into plausible noise wins by
        producing more of it, which is the failure the floor exists to prevent.
        """

        class Noisy:
            name = "noisy"
            preparations = ("binary", "image")

            def available(self) -> bool:
                return True

            def run(self, image: Any) -> OcrResult:
                if image == "binary-image":
                    return OcrResult(
                        words=[OcrWord(text="a" * 200, box=(0.0, 0.0, 10.0, 10.0), confidence=0.2)],
                        engine=self.name,
                    )
                return OcrResult(
                    words=[OcrWord(text="clean", box=(0.0, 0.0, 10.0, 10.0), confidence=0.95)],
                    engine=self.name,
                )

        engine = OcrPipeline(OcrOptions(), primary=Noisy(), fallback=FakeEngine("unused", 0.99))

        assert engine.process_page("colour-image", binary="binary-image").text == "clean"


class TestRapidOcrConfiguration:
    @staticmethod
    def shipped_config() -> dict[str, Any]:
        from pathlib import Path

        import rapidocr_onnxruntime
        import yaml

        path = Path(rapidocr_onnxruntime.__file__).parent / "config.yaml"
        return yaml.safe_load(path.read_text(encoding="utf-8"))

    def test_every_option_name_matches_a_key_rapidocr_actually_reads(self) -> None:
        """A misspelled kwarg is accepted and ignored, so it is pinned here.

        RapidOCR routes a `det_`-prefixed keyword into its detector's config
        section with the prefix stripped, and an unprefixed one into `Global`.
        A name that matches nothing is neither an error nor a warning — it is a
        setting that silently does nothing, which is the worst way for a
        configuration option to fail.
        """
        config = self.shipped_config()

        assert "text_score" in config["Global"]
        assert "max_side_len" in config["Global"]
        assert "intra_op_num_threads" in config["Global"]
        assert "box_thresh" in config["Det"]
        assert "unclip_ratio" in config["Det"]

    def test_the_side_length_ceiling_clears_a_letter_page_at_300_dpi(self) -> None:
        """RapidOCR's own default would resample it to about 180 DPI first."""
        shipped = float(self.shipped_config()["Global"]["max_side_len"])
        letter_long_edge_at_300 = 11.0 * 300.0

        assert shipped < letter_long_edge_at_300
        assert RapidOcrOptions().max_side_length >= letter_long_edge_at_300

    def test_an_engine_that_cannot_be_built_reports_itself_unavailable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Rather than raising on the first page of the first scanned document."""
        engine = RapidOcrEngine()
        monkeypatch.setattr(engine, "_load", lambda: None)

        assert engine.run(object()).words == []


class TestEngineOutputParsing:
    def test_a_pp_ocr_quadrilateral_becomes_the_box_that_holds_it(self) -> None:
        word = _rapid_word([[[10, 20], [110, 24], [110, 44], [10, 40]], "invoice", 0.94])

        assert word is not None
        assert word.box == (10.0, 20.0, 110.0, 44.0)
        assert word.confidence == pytest.approx(0.94)

    def test_an_empty_recognition_is_dropped_rather_than_stored(self) -> None:
        assert _rapid_word([[[0, 0], [1, 0], [1, 1], [0, 1]], "   ", 0.99]) is None

    def test_a_malformed_row_does_not_take_the_page_down(self) -> None:
        assert _rapid_word(["not a polygon"]) is None

    def test_tesseract_confidences_are_put_on_the_same_scale_as_everything_else(
        self,
    ) -> None:
        """It reports 0-100; two scales in one column is how 71 gets compared to 0.65."""
        words = _tesseract_words(
            {
                "text": ["Total"],
                "conf": ["71"],
                "left": [30],
                "top": [40],
                "width": [60],
                "height": [18],
            }
        )

        assert len(words) == 1
        assert words[0].confidence == pytest.approx(0.71)
        assert words[0].box == (30.0, 40.0, 90.0, 58.0)

    def test_tesseracts_structural_rows_are_not_counted_as_words(self) -> None:
        """It interleaves page, block, paragraph and line rows, all with `conf` -1."""
        words = _tesseract_words(
            {
                "text": ["", "Total"],
                "conf": ["-1", "88"],
                "left": [0, 30],
                "top": [0, 40],
                "width": [612, 60],
                "height": [792, 18],
            }
        )

        assert [word.text for word in words] == ["Total"]


class TestPixelsToPoints:
    def test_a_pixel_box_at_300_dpi_becomes_points(self) -> None:
        """72 points to the inch, so the whole conversion is one multiply."""
        raster = RasterPage(
            page_no=1, image=None, dpi=300.0, width_points=612.0, height_points=792.0
        )

        assert raster.scale == pytest.approx(POINTS_PER_INCH / 300.0)
        assert 300.0 * raster.scale == pytest.approx(72.0)

    def test_the_dpi_recorded_is_the_one_rendered_at(self) -> None:
        """An oversized page is rendered smaller to stay inside the memory ceiling.

        Storing the DPI that was *asked for* rather than the one that happened
        is the difference between a box on the word and a box near it.
        """
        raster = RasterPage(
            page_no=1, image=None, dpi=180.0, width_points=612.0, height_points=792.0
        )

        assert raster.scale == pytest.approx(0.4)

    def test_a_converted_box_lands_in_the_visible_frame_with_no_rotation_maths(
        self,
    ) -> None:
        """PDFium renders the rotated page, so the pixels are already visible-frame.

        This is the reason the OCR path calls `normalize` with `rotated=True`
        and contains no rotation table of its own.
        """
        geometry = PageGeometry(page_no=1, raw_width=612.0, raw_height=792.0, rotation=90)
        # A box 100pt from the left and 50pt down, on the visible 792x612 page.
        bbox = geometry.normalize(
            (100.0, 50.0, 300.0, 70.0), origin=CoordOrigin.top_left, rotated=True
        )

        assert bbox.as_list() == [100.0, 50.0, 300.0, 70.0]
        assert geometry.width == 792.0
        assert geometry.height == 612.0
