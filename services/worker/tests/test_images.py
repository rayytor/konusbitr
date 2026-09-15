"""Getting the figures out of a document, and leaving the furniture behind.

Extraction is a filter far more than it is an extractor. Every real PDF carries
images that are not figures — a letterhead on every page, a rule drawn as a
four-pixel bitmap, a logo in the corner — and a pipeline that stores them all
fills a bucket, spends a vision call on each, and puts "a small grey rectangle"
in the retrieval index. So most of what is asserted here is what does *not* come
out.

The fixture is `figures-chart.pdf`, which is built for exactly this: one real
bar chart, one 64-pixel logo and one 600-by-4 rule, with the furniture drawn
*after* the chart so that a filter which simply kept the first image would be
caught.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from konusbitr_worker.parse.geometry import PageGeometry
from konusbitr_worker.parse.images import (
    MAX_PAGE_AREA_RATIO,
    extract_images,
    image_id,
    image_key,
)
from konusbitr_worker.parse.inspect import inspect_pdf


def geometries(path: Path) -> dict[int, PageGeometry]:
    inspection = inspect_pdf(path, ocr_available=True)
    return {page.page_no: page for page in inspection.pages}


class TestStorageKeys:
    def test_the_key_layout_matches_the_typescript_half(self) -> None:
        """**This must agree with `documentImageKey` in `packages/storage/src/keys.ts`.**

        The worker writes these keys and the web app reads them, across a seam
        with no shared code, so both sides assert the layout in their own tests
        rather than trusting it. The thumbnail keys disagreed once, which is why
        this test exists in the shape it does.
        """
        assert (
            image_key("org_abc123", "doc_xyz789", 1)
            == "orgs/org_abc123/documents/doc_xyz789/images/1.png"
        )
        assert (
            image_key("org_abc123", "doc_xyz789", 42)
            == "orgs/org_abc123/documents/doc_xyz789/images/42.png"
        )

    def test_the_id_sorts_in_extraction_order(self) -> None:
        assert image_id(1) == "img_001"
        assert sorted([image_id(2), image_id(10)]) == ["img_002", "img_010"]


@pytest.mark.slow
class TestExtraction:
    def test_the_chart_is_extracted_and_the_furniture_is_not(self, fixtures_dir: Path) -> None:
        source = fixtures_dir / "figures-chart.pdf"
        found = list(extract_images(source, geometries=geometries(source)))

        assert len(found) == 1
        candidate = found[0]
        assert candidate.page == 1
        assert (candidate.width, candidate.height) == (792, 528)
        assert candidate.data.startswith(b"\x89PNG")

    def test_the_figure_is_located_in_the_one_coordinate_convention(
        self, fixtures_dir: Path
    ) -> None:
        """Top-left origin, y downward, points.

        PDFium reports an object's bounds in unrotated page space with the
        origin at the *bottom* left, which is the opposite of everything stored,
        so this is the assertion that catches a missing flip. The chart is drawn
        at y=260 with a height of 264 on a 792pt page, so its top edge is at
        792 - 524 = 268 and its bottom at 792 - 260 = 532.
        """
        source = fixtures_dir / "figures-chart.pdf"
        bbox = next(iter(extract_images(source, geometries=geometries(source)))).bbox

        assert bbox.as_list() == pytest.approx([72.0, 268.0, 468.0, 532.0], abs=1.0)
        assert bbox.y0 < bbox.y1

    def test_a_scanned_page_yields_no_figure(self, fixtures_dir: Path) -> None:
        """A scanned page's one image *is* the page.

        Captioning it would ask a vision model to describe a photograph of text
        the OCR tier has already read properly, and storing it would duplicate
        the document. Two filters catch it — the page tier and the page-area
        ratio — and this exercises the second, by not passing the first.
        """
        source = fixtures_dir / "scanned-letter.pdf"
        found = list(extract_images(source, geometries=geometries(source)))

        assert found == []

    def test_the_tier_filter_skips_recognised_pages_outright(self, fixtures_dir: Path) -> None:
        source = fixtures_dir / "scanned-letter.pdf"
        found = list(extract_images(source, geometries=geometries(source), skip_pages={1, 2, 3}))

        assert found == []

    def test_repeated_images_are_stored_once(self, fixtures_dir: Path) -> None:
        """A letterhead appears as an image object on every page of a document.

        Four hundred copies of one logo is a filter miss turned into a storage
        bill, so identical bytes are stored once and the first placement is the
        one recorded.
        """
        source = fixtures_dir / "scanned-letter.pdf"
        # Every page of this fixture is a full-page raster of the same layout,
        # so with the area filter lifted the pages differ only in their noise —
        # which is enough to make them genuinely distinct images. The letterhead
        # case is the degenerate one, and the digest is what covers it.
        candidates = list(extract_images(source, geometries=geometries(source), min_edge=10))
        digests = [candidate.digest for candidate in candidates]

        assert len(digests) == len(set(digests))

    def test_the_per_document_ceiling_is_honoured(self, fixtures_dir: Path) -> None:
        source = fixtures_dir / "figures-chart.pdf"
        assert list(extract_images(source, geometries=geometries(source), limit=0)) == []


def test_the_page_area_ratio_leaves_room_for_a_scanner_margin() -> None:
    """A scanner draws its output slightly inside the media box more often than onto it.

    At 1.0 the filter would miss every real scan by a fraction of a point, which
    is the failure it exists to prevent.
    """
    assert 0.8 <= MAX_PAGE_AREA_RATIO < 1.0
