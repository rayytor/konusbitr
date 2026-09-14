"""Preprocessing, and the map back from the frame it recognises in.

The four operations in :mod:`konusbitr_worker.parse.ocr.preprocess` exist to
make a degraded scan legible, and one of them — the deskew — moves every pixel
on the page. That is fine for recognition and catastrophic for coordinates
unless it is undone before a box is stored, so most of what is asserted here is
the inverse map rather than the image quality.

Image quality is hard to assert and easy to fool: a test that says "the
binarised page has fewer distinct grey levels" passes for any thresholding at
all, including one that erases the text. So the imaging assertions below are
narrow and structural, and the real evidence that preprocessing works is
`test_ocr_fixtures.py`, which recognises a deliberately damaged page and checks
what came back.
"""

from __future__ import annotations

import numpy as np
import pytest

from konusbitr_worker.parse.ocr.preprocess import (
    MAX_DESKEW_DEGREES,
    MIN_DESKEW_DEGREES,
    MIN_OCR_DPI,
    preprocess,
)


def page_of_text(width: int = 800, height: int = 1000, rotate: float = 0.0) -> np.ndarray:
    """A white page with black horizontal bars where lines of text would be."""
    import cv2

    image = np.full((height, width, 3), 255, dtype=np.uint8)
    for index in range(12):
        top = 120 + index * 60
        cv2.rectangle(image, (100, top), (width - 140, top + 22), (20, 20, 20), -1)

    if rotate:
        centre = (width / 2.0, height / 2.0)
        matrix = cv2.getRotationMatrix2D(centre, rotate, 1.0)
        image = cv2.warpAffine(image, matrix, (width, height), borderValue=(255, 255, 255))
    return image


class TestInverseMap:
    def test_an_unrotated_page_maps_back_to_itself(self) -> None:
        prepared = preprocess(page_of_text(), dpi=MIN_OCR_DPI, deskew_enabled=False)

        assert prepared.upscale == pytest.approx(1.0)
        assert prepared.to_source(0.0, 0.0) == pytest.approx((0.0, 0.0), abs=1e-6)
        assert prepared.to_source(400.0, 500.0) == pytest.approx((400.0, 500.0), abs=1e-6)

    def test_an_upscaled_page_maps_back_by_the_upscale_factor(self) -> None:
        """A 150 DPI page is doubled before recognition, so its boxes are halved."""
        prepared = preprocess(page_of_text(), dpi=150.0, deskew_enabled=False)

        assert prepared.upscale == pytest.approx(2.0)
        assert prepared.to_source(400.0, 500.0) == pytest.approx((200.0, 250.0), abs=1e-6)

    def test_a_deskewed_page_maps_a_box_back_onto_its_own_ink(self) -> None:
        """The assertion the whole module exists for.

        A box found on the straightened page has to come back to where the ink
        actually is on the page as stored. Without the inverse map every
        highlight on a skewed scan is wrong by the skew angle — a few points at
        the top of the page and most of a line at the bottom, which reads as a
        rounding error until somebody scrolls down.
        """
        import cv2

        skewed = page_of_text(rotate=-4.0)
        prepared = preprocess(skewed, dpi=MIN_OCR_DPI)

        assert abs(prepared.deskew_degrees) > MIN_DESKEW_DEGREES

        # The darkest run on the straightened page, found honestly rather than
        # assumed: this is where a recogniser would have put a box.
        grey = cv2.cvtColor(prepared.image, cv2.COLOR_RGB2GRAY)
        rows = np.where(grey.min(axis=1) < 100)[0]
        columns = np.where(grey.min(axis=0) < 100)[0]
        box = (float(columns[0]), float(rows[0]), float(columns[-1]), float(rows[-1]))

        mapped = prepared.box_to_source(box)
        source_grey = cv2.cvtColor(skewed, cv2.COLOR_RGB2GRAY)
        source_rows = np.where(source_grey.min(axis=1) < 100)[0]

        # The mapped box's vertical span must contain the ink on the source
        # page. Loose by a few pixels because un-rotating a rectangle produces a
        # rectangle at an angle, and what is stored is the box that encloses it.
        assert mapped[1] <= float(source_rows[0]) + 6
        assert mapped[3] >= float(source_rows[-1]) - 6

    def test_the_inverse_is_a_true_inverse(self) -> None:
        prepared = preprocess(page_of_text(), dpi=200.0)
        forward_height, forward_width = prepared.image.shape[:2]

        centre = prepared.to_source(forward_width / 2.0, forward_height / 2.0)
        assert centre[0] == pytest.approx(400.0, abs=2.0)
        assert centre[1] == pytest.approx(500.0, abs=2.0)


class TestDeskewBand:
    def test_a_straight_page_is_not_rotated(self) -> None:
        """Rotating a bitmap resamples every pixel; half a degree is not worth it."""
        prepared = preprocess(page_of_text(), dpi=MIN_OCR_DPI)

        assert prepared.deskew_degrees == 0.0

    def test_deskew_can_be_switched_off(self) -> None:
        prepared = preprocess(page_of_text(rotate=-4.0), dpi=MIN_OCR_DPI, deskew_enabled=False)

        assert prepared.deskew_degrees == 0.0

    def test_the_band_excludes_a_quarter_turn(self) -> None:
        """A page at 60 degrees was scanned sideways, or the detector locked onto a rule.

        Straightening it turns a readable page into an unreadable one, and a
        quarter turn is `/Rotate`, which PDFium applied before this module saw
        the bitmap.
        """
        assert MIN_DESKEW_DEGREES < MAX_DESKEW_DEGREES < 90.0


class TestProducts:
    def test_both_products_share_one_geometry(self) -> None:
        """One `to_source` has to cover both, so they must be the same size."""
        prepared = preprocess(page_of_text(rotate=-3.0), dpi=MIN_OCR_DPI)

        assert prepared.binary.shape[:2] == prepared.image.shape[:2]

    def test_the_binary_product_is_two_valued(self) -> None:
        prepared = preprocess(page_of_text(), dpi=MIN_OCR_DPI)

        assert set(np.unique(prepared.binary)).issubset({0, 255})

    def test_binarisation_keeps_the_text_under_an_uneven_light(self) -> None:
        """The case a global Otsu threshold gets wrong.

        A gradient across the page puts the paper on the dark side below the
        ink on the light side, so one threshold for the whole page either erases
        the text in the shadow or floods the lit half with black.
        """
        page = page_of_text().astype(np.float32)
        ramp = np.linspace(1.0, 0.45, page.shape[1], dtype=np.float32)[None, :, None]
        shadowed = (page * ramp).astype(np.uint8)

        prepared = preprocess(shadowed, dpi=MIN_OCR_DPI, deskew_enabled=False)
        binary = prepared.binary

        # Ink survives in both halves, and neither half is flooded.
        left, right = np.split(binary, 2, axis=1)
        for half in (left, right):
            dark = float((half == 0).mean())
            assert 0.01 < dark < 0.5
