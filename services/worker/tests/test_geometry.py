"""The coordinate convention, asserted against hand-computed numbers.

`docs/coordinates.md` says: PDF points, origin top-left, y increasing downward,
on the unrotated page. Everything here checks that sentence against arithmetic
somebody can redo on paper, rather than against whatever a parser produced —
which is the only way a golden file can be *wrong* rather than merely different.

The assertion that earns its place more than any other is the inverted-axis
one. A flipped y axis produces boxes that are the right size, on the right
page, in the right column, and in exactly the wrong place — output that looks
completely reasonable until somebody clicks a citation.
"""

from __future__ import annotations

import pytest

from konusbitr_worker.parse.geometry import BBox, CoordOrigin, PageGeometry, normalize_rotation

LETTER = (612.0, 792.0)
A4 = (595.28, 841.89)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, 0),
        (0, 0),
        (90, 90),
        (180, 180),
        (270, 270),
        (-90, 270),
        (450, 90),
        (360, 0),
        (47, 90),
    ],
)
def test_rotation_is_reduced_to_a_quarter_turn(raw: int | None, expected: int) -> None:
    """PDFs in the wild carry negatives, multiples beyond 360, and nonsense."""
    assert normalize_rotation(raw) == expected


def test_a_bottom_left_box_is_flipped_onto_a_top_left_axis() -> None:
    """The conversion PDF itself forces: its origin is at the bottom."""
    page = PageGeometry(page_no=1, raw_width=LETTER[0], raw_height=LETTER[1])

    # A heading 72pt down from the top of a 792pt page sits at y=720 in PDF's
    # own frame, with its top edge above its bottom edge in value.
    box = page.normalize((72.0, 720.0, 540.0, 702.0), origin=CoordOrigin.bottom_left)

    assert box.as_list() == [72.0, 72.0, 540.0, 90.0]


def test_a_heading_near_the_top_stays_near_the_top() -> None:
    """The inverted-axis assertion, stated as the property it protects."""
    page = PageGeometry(page_no=1, raw_width=LETTER[0], raw_height=LETTER[1])

    heading = page.normalize((72.0, 760.0, 540.0, 742.0), origin=CoordOrigin.bottom_left)
    footer = page.normalize((72.0, 50.0, 540.0, 32.0), origin=CoordOrigin.bottom_left)

    assert heading.y0 < footer.y0
    assert heading.y0 < page.height * 0.1
    assert footer.y0 > page.height * 0.9


def test_a_top_left_box_is_only_sorted() -> None:
    page = PageGeometry(page_no=1, raw_width=LETTER[0], raw_height=LETTER[1])

    box = page.normalize((540.0, 90.0, 72.0, 72.0), origin=CoordOrigin.top_left)

    assert box.as_list() == [72.0, 72.0, 540.0, 90.0]


def test_a_non_letter_page_is_measured_against_its_own_size() -> None:
    """A4 is 595 by 842. A parser that assumed Letter would be 50pt out vertically."""
    page = PageGeometry(page_no=1, raw_width=A4[0], raw_height=A4[1])

    box = page.normalize((72.0, A4[1] - 72.0, 523.0, A4[1] - 90.0), origin=CoordOrigin.bottom_left)

    assert box.as_list() == [72.0, 72.0, 523.0, 90.0]
    assert (page.width, page.height) == pytest.approx(A4)


class TestRotation:
    """Each quarter turn maps the unrotated frame onto the frame a reader sees."""

    def test_a_quarter_turn_swaps_the_visible_dimensions(self) -> None:
        page = PageGeometry(page_no=1, raw_width=A4[0], raw_height=A4[1], rotation=90)

        assert page.width == pytest.approx(A4[1])
        assert page.height == pytest.approx(A4[0])

    def test_ninety_degrees(self) -> None:
        page = PageGeometry(page_no=1, raw_width=600.0, raw_height=800.0, rotation=90)

        # Top-left corner of the unrotated page becomes the top-right of the
        # visible one: the page turned clockwise, so the box travelled with it.
        box = page.normalize((10.0, 20.0, 110.0, 60.0), origin=CoordOrigin.top_left)

        assert box.as_list() == [740.0, 10.0, 780.0, 110.0]
        assert box.x1 <= page.width and box.y1 <= page.height

    def test_one_hundred_and_eighty_degrees(self) -> None:
        page = PageGeometry(page_no=1, raw_width=600.0, raw_height=800.0, rotation=180)

        box = page.normalize((10.0, 20.0, 110.0, 60.0), origin=CoordOrigin.top_left)

        assert box.as_list() == [490.0, 740.0, 590.0, 780.0]

    def test_two_hundred_and_seventy_degrees(self) -> None:
        page = PageGeometry(page_no=1, raw_width=600.0, raw_height=800.0, rotation=270)

        box = page.normalize((10.0, 20.0, 110.0, 60.0), origin=CoordOrigin.top_left)

        assert box.as_list() == [20.0, 490.0, 60.0, 590.0]

    def test_a_source_that_already_rotated_is_not_rotated_again(self) -> None:
        """The flag that keeps Docling's pre-rotated output from turning twice.

        Applying the rotation a second time is invisible on a square figure and
        glaring on a line of text, which is exactly the kind of bug that ships.
        """
        page = PageGeometry(page_no=1, raw_width=600.0, raw_height=800.0, rotation=90)

        box = page.normalize((10.0, 20.0, 110.0, 60.0), origin=CoordOrigin.top_left, rotated=True)

        assert box.as_list() == [10.0, 20.0, 110.0, 60.0]

    def test_a_pre_rotated_bottom_left_box_flips_against_the_visible_height(self) -> None:
        page = PageGeometry(page_no=1, raw_width=600.0, raw_height=800.0, rotation=90)

        # Visible height is 600, not 800.
        box = page.normalize(
            (10.0, 580.0, 110.0, 560.0), origin=CoordOrigin.bottom_left, rotated=True
        )

        assert box.as_list() == [10.0, 20.0, 110.0, 40.0]


def test_a_box_is_clamped_back_inside_its_page() -> None:
    """Glyph overshoot is real and a highlight that runs off the page is not."""
    page = PageGeometry(page_no=1, raw_width=612.0, raw_height=792.0)

    box = page.normalize((-3.0, -4.0, 900.0, 900.0), origin=CoordOrigin.top_left)

    assert box.as_list() == [0.0, 0.0, 612.0, 792.0]


def test_a_box_with_no_area_is_reported_as_degenerate() -> None:
    """Nothing can be highlighted, so the normalizer's callers drop it."""
    assert BBox(10.0, 10.0, 10.0, 40.0).is_degenerate
    assert BBox(10.0, 10.0, 40.0, 10.0).is_degenerate
    assert not BBox(10.0, 10.0, 40.0, 40.0).is_degenerate
