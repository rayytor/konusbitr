"""The structural pass: what is learned about a PDF before Docling is asked anything.

These questions are cheap and the answers are terminal, which is why they are
asked first. A corrupt file rejected in twelve milliseconds is a corrupt file
that never loaded a layout model, and a scanned document refused outright is a
chat that never answers confidently out of an empty parse.

The coverage arithmetic gets its own tests because it is the only number in the
phase that is a judgement rather than a fact, and because the failure it
prevents — a plausible answer built on nothing — is the worst one available.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from konusbitr_worker.contracts import JobErrorCode
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.parse.artifact import PageTier
from konusbitr_worker.parse.geometry import PageGeometry
from konusbitr_worker.parse.inspect import (
    CHARS_PER_SQUARE_INCH_AT_FULL_COVERAGE,
    DocumentInspection,
    _coverage,
    classify_page_tier,
    inspect_pdf,
    require_text_layer,
)

LETTER_SQUARE_INCHES = (612 / 72) * (792 / 72)


class TestCoverage:
    def test_a_page_with_no_characters_scores_zero(self) -> None:
        assert _coverage(0, 612.0, 792.0) == 0.0

    def test_a_page_with_a_real_text_layer_saturates(self) -> None:
        """The score answers "is there a text layer", so it tops out early."""
        full = int(LETTER_SQUARE_INCHES * CHARS_PER_SQUARE_INCH_AT_FULL_COVERAGE)
        assert _coverage(full, 612.0, 792.0) == 1.0
        assert _coverage(full * 40, 612.0, 792.0) == 1.0

    def test_coverage_is_normalized_by_area_not_by_a_flat_count(self) -> None:
        """Otherwise an A6 page of dense text reads as a scan.

        A small page holds fewer characters at the same type size, and
        comparing it to a flat threshold would refuse a perfectly good
        born-digital document for being small.
        """
        a6 = _coverage(40, 298.0, 420.0)
        letter = _coverage(40, 612.0, 792.0)

        assert a6 > letter
        # Forty characters is a headline and a byline. On a small page that is a
        # text layer; on a poster it is barely a caption, and only the small page
        # clears the default threshold comfortably.
        assert a6 > 0.1

    def test_a_page_with_no_area_does_not_divide_by_zero(self) -> None:
        assert _coverage(100, 0.0, 792.0) == 0.0


class TestTextLayerRequirement:
    @staticmethod
    def inspection(scores: list[float]) -> DocumentInspection:
        return DocumentInspection(
            page_count=len(scores),
            pages=[
                PageGeometry(page_no=index + 1, raw_width=612.0, raw_height=792.0)
                for index in range(len(scores))
            ],
            coverage=scores,
        )

    def test_a_fully_born_digital_document_passes(self) -> None:
        require_text_layer(self.inspection([0.8] * 10), 0.1)

    def test_a_scanned_page_or_two_inside_a_text_document_passes(self) -> None:
        """A signature page or a full-page chart is normal and must not fail an upload."""
        require_text_layer(self.inspection([0.8] * 9 + [0.0]), 0.1)

    def test_a_document_that_is_mostly_images_is_refused(self) -> None:
        with pytest.raises(JobFailure) as raised:
            require_text_layer(self.inspection([0.0] * 8 + [0.9, 0.9]), 0.1)

        assert raised.value.code is JobErrorCode.needs_ocr
        assert raised.value.retryable is False

    def test_the_threshold_is_the_operators_to_raise(self) -> None:
        """`TEXT_COVERAGE_THRESHOLD` is configuration, and it has to bite."""
        moderate = self.inspection([0.3] * 10)

        require_text_layer(moderate, 0.1)
        with pytest.raises(JobFailure):
            require_text_layer(moderate, 0.5)

    def test_the_boundary_is_a_fifth_of_the_pages(self) -> None:
        exactly_a_fifth = self.inspection([0.0] * 2 + [0.9] * 8)
        just_over = self.inspection([0.0] * 3 + [0.9] * 7)

        require_text_layer(exactly_a_fifth, 0.1)
        with pytest.raises(JobFailure):
            require_text_layer(just_over, 0.1)


class TestOpening:
    def test_a_file_that_is_not_a_pdf_is_corrupt_not_internal(self, tmp_path: Path) -> None:
        """Terminal on the first attempt: three retries would each fail identically."""
        path = tmp_path / "notes.txt"
        path.write_text("This has never been a PDF.", encoding="utf-8")

        with pytest.raises(JobFailure) as raised:
            inspect_pdf(path)

        assert raised.value.code is JobErrorCode.corrupt_document
        assert raised.value.retryable is False

    def test_an_empty_file_is_corrupt(self, tmp_path: Path) -> None:
        path = tmp_path / "empty.pdf"
        path.write_bytes(b"")

        with pytest.raises(JobFailure) as raised:
            inspect_pdf(path)

        assert raised.value.code is JobErrorCode.corrupt_document

    def test_a_good_document_reports_its_geometry(self, fixtures_dir: Path) -> None:
        inspection = inspect_pdf(fixtures_dir / "clean-text-10p.pdf")

        assert inspection.page_count == 10
        first = inspection.pages[0]
        assert (round(first.width), round(first.height)) == (612, 792)
        assert first.rotation == 0

    def test_a_rotated_page_reports_the_frame_a_reader_sees(self, fixtures_dir: Path) -> None:
        inspection = inspect_pdf(fixtures_dir / "rotated-a4.pdf")

        upright, rotated, _last = inspection.pages
        assert (round(upright.width), round(upright.height)) == (595, 842)
        assert rotated.rotation == 90
        assert (round(rotated.width), round(rotated.height)) == (842, 595)

    def test_an_encrypted_document_says_so_rather_than_claiming_damage(
        self, fixtures_dir: Path
    ) -> None:
        with pytest.raises(JobFailure) as raised:
            inspect_pdf(fixtures_dir / "encrypted.pdf")

        assert raised.value.code is JobErrorCode.encrypted_document
        assert "password" in raised.value.message.lower()

    def test_a_truncated_document_is_corrupt(self, fixtures_dir: Path) -> None:
        with pytest.raises(JobFailure) as raised:
            inspect_pdf(fixtures_dir / "malformed.pdf")

        assert raised.value.code is JobErrorCode.corrupt_document

    def test_a_scan_is_refused_when_nothing_can_read_it(self, fixtures_dir: Path) -> None:
        """The Phase 07 behaviour, which survives as the no-recogniser case."""
        with pytest.raises(JobFailure) as raised:
            inspect_pdf(fixtures_dir / "scanned-no-text.pdf")

        assert raised.value.code is JobErrorCode.needs_ocr

    def test_the_page_ceiling_is_checked_here(self, fixtures_dir: Path) -> None:
        with pytest.raises(JobFailure) as raised:
            inspect_pdf(fixtures_dir / "clean-text-10p.pdf", max_pages=4)

        assert raised.value.code is JobErrorCode.too_many_pages

    def test_a_zero_page_ceiling_means_unlimited(self, fixtures_dir: Path) -> None:
        assert inspect_pdf(fixtures_dir / "clean-text-10p.pdf", max_pages=0).page_count == 10


class TestPageTiers:
    """Per-page tiering: the Phase 12.1 change to what this module measures.

    The measurement did not change. What changed is the granularity at which its
    answer is acted on — a document is no longer refused or accepted whole, and
    a hundred-page filing with three scanned exhibits sends three pages to a
    recogniser rather than all of them or none.
    """

    def test_a_page_with_a_text_layer_is_native(self) -> None:
        assert classify_page_tier(0.8, threshold=0.1) is PageTier.native

    def test_a_page_with_no_text_layer_is_ocr(self) -> None:
        assert classify_page_tier(0.0, threshold=0.1) is PageTier.ocr

    def test_the_threshold_is_inclusive_at_the_boundary(self) -> None:
        """A page exactly at the threshold has cleared it, not fallen short of it."""
        assert classify_page_tier(0.1, threshold=0.1) is PageTier.native

    def test_a_thin_text_layer_is_still_a_scan(self) -> None:
        """The case a "has any text at all" test gets wrong.

        A scan under a running header has extractable characters on it, and
        parsing it on the strength of them returns the header and nothing else.
        """
        assert classify_page_tier(0.02, threshold=0.1) is PageTier.ocr

    def test_a_wholly_scanned_document_tiers_every_page_for_recognition(
        self, fixtures_dir: Path
    ) -> None:
        inspection = inspect_pdf(fixtures_dir / "scanned-letter.pdf", ocr_available=True)

        assert inspection.pages_in_tier(PageTier.native) == []
        assert inspection.pages_in_tier(PageTier.ocr) == [1, 2, 3]

    def test_a_mixed_document_tiers_only_the_scanned_pages(self, fixtures_dir: Path) -> None:
        """Seven born-digital pages and three photocopies, told apart by page."""
        inspection = inspect_pdf(fixtures_dir / "mixed-digital-scanned-10p.pdf", ocr_available=True)

        assert inspection.pages_in_tier(PageTier.native) == [1, 2, 3, 4, 5, 6, 7]
        assert inspection.pages_in_tier(PageTier.ocr) == [8, 9, 10]

    def test_a_born_digital_document_tiers_nothing_for_recognition(
        self, fixtures_dir: Path
    ) -> None:
        inspection = inspect_pdf(fixtures_dir / "clean-text-10p.pdf", ocr_available=True)

        assert inspection.pages_in_tier(PageTier.ocr) == []

    def test_a_scan_is_no_longer_refused_when_something_can_read_it(
        self, fixtures_dir: Path
    ) -> None:
        """The headline change: what Phase 07 failed with `needs_ocr` now parses."""
        inspection = inspect_pdf(fixtures_dir / "scanned-letter.pdf", ocr_available=True)

        assert inspection.page_count == 3

    def test_tier_of_falls_back_to_native_for_an_unknown_page(self) -> None:
        inspection = DocumentInspection(
            page_count=1,
            pages=[PageGeometry(page_no=1, raw_width=612.0, raw_height=792.0)],
            coverage=[0.0],
            tiers=[PageTier.ocr],
        )

        assert inspection.tier_of(1) is PageTier.ocr
        assert inspection.tier_of(99) is PageTier.native
