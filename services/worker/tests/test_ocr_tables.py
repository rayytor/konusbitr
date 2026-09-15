"""Recovering a ruled table's grid, and putting the recognised words back in it.

Two halves, tested apart because they fail apart. The **structure** — where the
rules are, how many rows and columns they make, which cells are merged — is
geometry over a bitmap and is tested against bitmaps drawn here, where the
answer is known by construction. The **assignment** — which word lands in which
cell — is arithmetic over boxes and needs no image at all.

Drawn rather than rendered from a fixture on purpose. A test whose input is a
scanned PDF cannot distinguish "the grid detector is wrong" from "the recogniser
read nothing", and the two have completely different fixes. The end-to-end
claim is `test_table_fixtures.py`.
"""

from __future__ import annotations

import numpy as np
import pytest

from konusbitr_worker.parse.ocr.engines import OcrWord
from konusbitr_worker.parse.ocr.pipeline import _is_numeric, _looks_like_a_header, _matrix
from konusbitr_worker.parse.ocr.tables import (
    TableCell,
    TableGrid,
    assign_words,
    detect_tables,
)


def canvas(width: int = 800, height: int = 600):
    """A blank binarised page: white paper, ready for black rules."""
    return np.full((height, width), 255, dtype=np.uint8)


def rule(image, x0: int, y0: int, x1: int, y1: int, thickness: int = 3) -> None:
    """Draw one black rule, as a scanner would leave it."""
    image[y0 : y1 + thickness, x0 : x1 + thickness] = 0


def draw_grid(
    image,
    *,
    left: int,
    top: int,
    column_width: int,
    row_height: int,
    columns: int,
    rows: int,
    skip_vertical: set[tuple[int, int]] | None = None,
) -> None:
    """Draw a complete grid, optionally omitting some interior vertical segments.

    An omitted segment is exactly what a merged cell looks like on the page, and
    is what `_cells` reads a span off.
    """
    skip = skip_vertical or set()
    right = left + column_width * columns

    for index in range(rows + 1):
        y = top + index * row_height
        rule(image, left, y, right, y)

    for column in range(columns + 1):
        x = left + column * column_width
        for row in range(rows):
            if (row, column) in skip:
                continue
            y0 = top + row * row_height
            rule(image, x, y0, x, y0 + row_height)


class TestDetection:
    def test_a_ruled_grid_becomes_a_table(self) -> None:
        image = canvas()
        draw_grid(image, left=60, top=60, column_width=160, row_height=60, columns=4, rows=5)

        grids = detect_tables(image)

        assert len(grids) == 1
        assert (grids[0].rows, grids[0].cols) == (5, 4)
        assert len(grids[0].cells) == 20

    def test_a_page_with_no_rules_has_no_table(self) -> None:
        """The overwhelmingly common case, and it must cost two passes and nothing else."""
        assert detect_tables(canvas()) == []

    def test_a_single_ruled_box_is_not_a_table(self) -> None:
        """One ruled box is a signature block or a form field.

        Rendering it as a table costs a citable paragraph and buys nothing, which
        is why the floor is two rows and two columns rather than one of each.
        """
        image = canvas()
        draw_grid(image, left=60, top=60, column_width=300, row_height=120, columns=1, rows=1)

        assert detect_tables(image) == []

    def test_two_tables_on_one_page_are_found_separately(self) -> None:
        image = canvas(height=900)
        draw_grid(image, left=60, top=40, column_width=150, row_height=50, columns=3, rows=3)
        draw_grid(image, left=60, top=500, column_width=150, row_height=50, columns=4, rows=3)

        grids = detect_tables(image)

        assert [(grid.rows, grid.cols) for grid in grids] == [(3, 3), (3, 4)]

    def test_a_merged_cell_is_one_cell_rather_than_several(self) -> None:
        """The rule that is *not* there is the whole of the detection.

        Every pair of adjacent base cells is separated by a rule or it is not,
        and where the segment between them is missing the two are one cell —
        which is the same information a reader uses and needs no model.
        """
        image = canvas()
        # The header row's interior verticals at columns 2 and 3 are omitted, so
        # its second, third and fourth cells are one cell spanning three.
        draw_grid(
            image,
            left=60,
            top=60,
            column_width=160,
            row_height=60,
            columns=4,
            rows=4,
            skip_vertical={(0, 2), (0, 3)},
        )

        grid = detect_tables(image)[0]

        merged = [cell for cell in grid.cells if cell.col_span > 1]
        assert len(merged) == 1
        assert (merged[0].row, merged[0].col, merged[0].col_span) == (0, 1, 3)
        # Twelve base cells below the header, plus the header's own two.
        assert len(grid.cells) == 14


class TestWordAssignment:
    @staticmethod
    def grid() -> TableGrid:
        cells = [
            TableCell(
                row=row,
                col=col,
                row_span=1,
                col_span=1,
                box=(100.0 + col * 100, 100.0 + row * 50, 200.0 + col * 100, 150.0 + row * 50),
            )
            for row in range(2)
            for col in range(2)
        ]
        return TableGrid(box=(100.0, 100.0, 300.0, 200.0), rows=2, cols=2, cells=cells)

    def test_a_word_lands_in_the_cell_it_sits_in(self) -> None:
        grid = self.grid()
        words = [
            OcrWord(text="Revenue", box=(110.0, 110.0, 180.0, 130.0), confidence=0.9),
            OcrWord(text="4,120", box=(210.0, 160.0, 260.0, 180.0), confidence=0.8),
        ]

        leftover = assign_words([grid], words)

        assert leftover == []
        assert grid.cells[0].text == "Revenue"
        assert grid.cells[3].text == "4,120"

    def test_a_word_outside_every_table_is_left_for_the_prose(self) -> None:
        grid = self.grid()
        outside = OcrWord(text="Summary", box=(10.0, 10.0, 90.0, 30.0), confidence=0.9)

        assert assign_words([grid], [outside]) == [outside]
        assert all(not cell.words for cell in grid.cells)

    def test_a_word_is_claimed_once_and_only_once(self) -> None:
        """Partitioned rather than copied.

        A number in both a table chunk and a prose chunk is retrieved twice and
        cited from whichever won, and the two citations point at different
        rectangles.
        """
        grid = self.grid()
        inside = OcrWord(text="Revenue", box=(110.0, 110.0, 180.0, 130.0), confidence=0.9)

        assert assign_words([grid], [inside]) == []
        assert sum(len(cell.words) for cell in grid.cells) == 1

    def test_a_word_overhanging_a_rule_belongs_to_the_cell_it_is_mostly_in(self) -> None:
        """The centre decides, not containment.

        Requiring containment would drop an overhanging word from the table and
        leave it in the prose, where it would be cited as a stray paragraph
        beside the table it came out of.
        """
        grid = self.grid()
        straddling = OcrWord(text="Services", box=(150.0, 110.0, 210.0, 130.0), confidence=0.9)

        assert assign_words([grid], [straddling]) == []
        assert grid.cells[0].text == "Services"

    def test_a_cell_reads_its_words_in_reading_order(self) -> None:
        grid = self.grid()
        assign_words(
            [grid],
            [
                OcrWord(text="year", box=(110.0, 130.0, 150.0, 145.0), confidence=0.9),
                OcrWord(text="Fiscal", box=(110.0, 105.0, 160.0, 120.0), confidence=0.9),
            ],
        )

        assert grid.cells[0].text == "Fiscal year"


class TestHeaderDetection:
    def test_a_financial_header_row_survives_containing_years(self) -> None:
        """The rule this replaced — "a header contains no numbers" — fails here.

        The column headings of a financial statement are years, and a scan
        carries no bold type or shading for a heuristic to read instead. The
        test is per column: one column where the top cell is a label and
        everything under it is a figure is a pattern only a header produces.
        """
        assert _looks_like_a_header(
            [
                ["Segment", "2023", "2024", "Change"],
                ["Subscriptions", "4,120", "5,860", "42%"],
                ["Services", "1,905", "2,110", "11%"],
            ]
        )

    def test_a_table_with_no_header_row_gets_none_invented(self) -> None:
        """An empty `headers` is honest; a value where a column name goes is not."""
        assert not _looks_like_a_header(
            [
                ["Subscriptions", "4,120", "5,860"],
                ["Services", "1,905", "2,110"],
            ]
        )

    def test_a_table_of_nothing_but_words_gets_no_header(self) -> None:
        assert not _looks_like_a_header(
            [["Clause", "Summary"], ["Termination", "Either party may end the term"]]
        )

    def test_a_row_with_a_blank_cell_is_not_a_header(self) -> None:
        """A blank top-left corner is a row-and-column-headed matrix, not a header."""
        assert not _looks_like_a_header([["", "2023", "2024"], ["Europe", "84", "31"]])

    @pytest.mark.parametrize(
        "cell", ["4,120", "42%", "$18.2", "(1,905)", "-7", "2024", "1 905", "€689"]
    )
    def test_a_figure_is_recognised_through_its_punctuation(self, cell: str) -> None:
        assert _is_numeric(cell)

    @pytest.mark.parametrize("cell", ["Segment", "Q3 2024", "", "N/A", "2024e"])
    def test_a_label_is_not_mistaken_for_a_figure(self, cell: str) -> None:
        assert not _is_numeric(cell)


class TestMatrix:
    @staticmethod
    def merged_grid() -> TableGrid:
        cells = [
            TableCell(row=0, col=0, row_span=1, col_span=1, box=(0.0, 0.0, 10.0, 10.0)),
            TableCell(row=0, col=1, row_span=1, col_span=2, box=(10.0, 0.0, 30.0, 10.0)),
            TableCell(row=1, col=0, row_span=1, col_span=1, box=(0.0, 10.0, 10.0, 20.0)),
            TableCell(row=1, col=1, row_span=1, col_span=1, box=(10.0, 10.0, 20.0, 20.0)),
            TableCell(row=1, col=2, row_span=1, col_span=1, box=(20.0, 10.0, 30.0, 20.0)),
        ]
        for cell, text in zip(cells, ["Region", "Employees", "Europe", "84", "31"], strict=True):
            cell.words.append(OcrWord(text=text, box=cell.box, confidence=0.9))
        return TableGrid(box=(0.0, 0.0, 30.0, 20.0), rows=2, cols=3, cells=cells)

    def test_a_span_is_repeated_into_every_position_it_covers(self) -> None:
        """Markdown has no colspan, and `rows[r][c]` must not be an empty string.

        Phase 13's `extract` addressing a cell under a merged header should find
        the merged value rather than a blank it then has to search leftwards for.
        """
        assert _matrix(self.merged_grid(), rtl=False) == [
            ["Region", "Employees", "Employees"],
            ["Europe", "84", "31"],
        ]

    def test_a_right_to_left_table_starts_from_its_rightmost_column(self) -> None:
        """The grid was built from pixel positions, which know nothing about that."""
        assert _matrix(self.merged_grid(), rtl=True) == [
            ["Employees", "Employees", "Region"],
            ["31", "84", "Europe"],
        ]
