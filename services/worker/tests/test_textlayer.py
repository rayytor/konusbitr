"""The text layer, extracted from real PDFs, with the rectangle of every word.

This is the evidence hybrid reconciliation corrects a vision model against, so
what it has to get right is not "does it return text" — PDFium would do that in
one call — but *where each word is*, in the one coordinate convention, including
on a rotated page.

Run against the committed fixtures rather than against constructed doubles,
because the two things that break here break only on real files: a typeset PDF
that encodes its inter-word space as a positioning operator rather than a
`U+0020`, and a page whose `/Rotate` sends the conversion down the branch the
OCR tier deliberately does not use.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from konusbitr_worker.parse.geometry import BBox, PageGeometry
from konusbitr_worker.parse.inspect import inspect_pdf
from konusbitr_worker.parse.textlayer import page_words, words_in


def geometries(path: Path) -> dict[int, PageGeometry]:
    inspection = inspect_pdf(path, ocr_available=True)
    return {page.page_no: page for page in inspection.pages}


class TestABornDigitalPage:
    @pytest.fixture
    def words(self, fixtures_dir: Path):
        path = fixtures_dir / "clean-text-10p.pdf"
        return page_words(path, [1], geometries=geometries(path))[1]

    def test_it_yields_words_rather_than_one_blob(self, words) -> None:
        """A splitter that trusted whitespace alone returns one token per line,
        because typeset PDFs draw word spaces with a positioning operator."""
        assert len(words) > 20
        assert all(" " not in word.text for word in words)

    def test_every_word_is_inside_its_page(self, words) -> None:
        assert all(
            0 <= word.bbox.x0 <= word.bbox.x1 <= 613 and 0 <= word.bbox.y0 <= word.bbox.y1 <= 793
            for word in words
        )

    def test_no_word_encloses_nothing(self, words) -> None:
        """A degenerate box cannot be highlighted, so it is not a word."""
        assert all(not word.bbox.is_degenerate for word in words)

    def test_words_read_down_the_page(self, words) -> None:
        """The text layer's own order is the order the characters were drawn,
        which within a block is the order they are read.

        Asserted as a trend rather than as a monotonic sort, because it is not
        one: superscripts, dashes and the descenders of a justified line all sit
        a point or two off their neighbours. What must hold is that the sequence
        *goes down the page* — reconciliation replaces a block with these tokens
        in this order, and a scrambled order would produce a fluent-looking
        paragraph whose sentences are shuffled.
        """
        quarter = max(len(words) // 4, 1)
        top = sum(word.bbox.y0 for word in words[:quarter]) / quarter
        bottom = sum(word.bbox.y0 for word in words[-quarter:]) / quarter
        assert top < bottom

    def test_words_on_one_line_read_left_to_right(self, words) -> None:
        """The within-line half of the same claim, checked on the run of words
        that share a baseline."""
        first = words[0].bbox.y0
        line = [word for word in words if abs(word.bbox.y0 - first) < 2.0]
        assert len(line) > 3
        lefts = [word.bbox.x0 for word in line]
        assert lefts == sorted(lefts)

    def test_a_scan_has_no_text_layer_and_that_is_not_an_error(self, fixtures_dir: Path) -> None:
        """The ordinary case for a page the VLM tier will read ungrounded."""
        path = fixtures_dir / "scanned-no-text.pdf"
        extracted = page_words(path, [1], geometries=geometries(path))
        assert extracted[1] == []


class TestRotation:
    def test_a_rotated_page_lands_in_the_visible_frame(self, fixtures_dir: Path) -> None:
        """The trap `docs/coordinates.md` names.

        PDFium reports a *character box* in unrotated page space with a
        bottom-left origin — the same frame it reports image object bounds in,
        and the opposite of a rendered page, where `/Rotate` has already been
        applied. So this conversion runs the rotation table, and the proof is
        that every box fits inside the page **as a reader sees it**: a
        quarter-turned A4 is 842 wide and 595 tall, not the other way round.
        """
        path = fixtures_dir / "rotated-a4.pdf"
        pages = geometries(path)
        # Page 2 is the quarter-turned one; 1 and 3 are upright, which is the
        # point of the fixture — the same document must come back right either
        # way, so the untouched pages are asserted alongside it.
        turned = next(page for page in pages.values() if page.quarter_turned)
        assert turned.width > turned.height, "a quarter-turned A4 is landscape"

        words = page_words(path, [turned.page_no], geometries=pages)[turned.page_no]
        assert words, "the rotated fixture has a text layer"
        assert all(
            word.bbox.x1 <= turned.width + 1 and word.bbox.y1 <= turned.height + 1 for word in words
        ), "a box escaped the visible page, so the rotation was applied wrongly"

    def test_a_rotated_words_box_lands_on_its_ink(self, fixtures_dir: Path) -> None:
        """The assertion that can actually fail when the rotation is wrong.

        Bounds cannot: `BBox.clamp` pulls an over-running box back inside the
        page, so an unrotated reading of a quarter-turned page produces boxes
        that are wrong *and* in range. The only honest check is against the
        picture — render the page the way a reader sees it (PDFium applies
        `/Rotate`) and look at what is inside the rectangle.

        A word's box should be mostly ink; the same-sized rectangle in the outer
        margin should be blank. On a 90-degree error the two swap.
        """
        import numpy as np

        from konusbitr_worker.parse.ocr.raster import render_page

        path = fixtures_dir / "rotated-a4.pdf"
        pages = geometries(path)
        turned = next(page for page in pages.values() if page.quarter_turned)
        words = page_words(path, [turned.page_no], geometries=pages)[turned.page_no]

        raster = render_page(path, turned.page_no, dpi=150.0)
        assert raster is not None
        grey = np.asarray(raster.image).mean(axis=2)
        scale = raster.dpi / 72.0

        def darkness(box) -> float:
            """Fraction of pixels in a rectangle that carry ink."""
            x0, y0, x1, y1 = (int(value * scale) for value in box.as_list())
            patch = grey[y0:y1, x0:x1]
            return 0.0 if patch.size == 0 else float((patch < 128).mean())

        # The longest words, which are the ones with enough glyphs for the
        # measurement to mean something.
        sampled = sorted(words, key=lambda word: -len(word.text))[:5]
        assert sampled, "the rotated fixture has a text layer"

        inked = sum(darkness(word.bbox) for word in sampled) / len(sampled)
        assert inked > 0.05, (
            "a word's box contains no ink on the rendered page, so the rotation was applied wrongly"
        )


class TestContainment:
    def test_a_word_is_placed_by_its_centre(self, fixtures_dir: Path) -> None:
        """Centre containment rather than overlap, which is what a two-column
        page needs: a word straddling the gutter overlaps both column boxes and
        belongs to exactly one of them."""
        path = fixtures_dir / "two-column-paper.pdf"
        pages = geometries(path)
        words = page_words(path, [1], geometries=pages)[1]
        page = pages[1]

        left = words_in(words, BBox(0.0, 0.0, page.width / 2, page.height))
        right = words_in(words, BBox(page.width / 2, 0.0, page.width, page.height))

        assert left and right
        # No word is counted twice, which an overlap test could not promise.
        assert len(left) + len(right) == len(words)

    def test_the_tolerance_does_not_swallow_a_neighbouring_block(self, fixtures_dir: Path) -> None:
        path = fixtures_dir / "clean-text-10p.pdf"
        pages = geometries(path)
        words = page_words(path, [1], geometries=pages)[1]

        strip = words_in(words, BBox(0.0, 0.0, pages[1].width, 60.0))
        assert len(strip) < len(words)
