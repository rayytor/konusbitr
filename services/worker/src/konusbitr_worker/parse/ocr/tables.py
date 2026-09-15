"""Recovering a table's grid from a scanned page, and putting words back in cells.

A scanned balance sheet flattened into prose is the worst thing this pipeline
can produce short of silence. The numbers survive, the row labels survive, and
the association between them — which is the entire content of a financial table
— does not. Ask "what were services in 2024?" of that chunk and retrieval
returns it happily, because every word in the question is on the page, and the
model then picks a number out of a row of numbers with nothing to bind it to.

So the grid is reconstructed before the words are grouped into paragraphs, and
the reconstruction is done from the **ruling lines**. That choice is worth
stating plainly, because it is a narrowing:

**Ruled tables only.** A table drawn with visible rules — which is what a
balance sheet, an invoice, a lab report and a clinical summary all are — has its
own structure printed on it, and morphological line extraction recovers that
structure exactly rather than inferring it. A table held together by whitespace
alone has no such signal, and a column-inference heuristic over word positions
is precisely the kind of thing that works on the fixture and transposes a real
document's columns. Those pages keep the Phase 12.1 behaviour: the rows are read
as lines of prose, which is honest and citable even though it is not a table.
Full structure inference on an unruled scan is a layout model's job and is Phase
12.3, with the VLM tier.

**The rules are found, not guessed.** Two morphological passes — erode with a
long horizontal kernel, then with a long vertical one — leave only strokes that
run most of the width or height of a cell, which is what a rule is and what a
line of text is not. Their intersections are the grid.

**Merged cells are read off the absent segments.** Every pair of adjacent base
cells is separated by a rule or it is not; where the segment between them is
missing, the two are one cell. That is the same information a reader uses and it
needs no model.

Everything here speaks **pixels of the preprocessed page**, exactly as
:mod:`konusbitr_worker.parse.ocr.engines` does, and for the same reason: the one
conversion into the Konusbitr coordinate convention lives in
:mod:`konusbitr_worker.parse.ocr.pipeline` and must not be duplicated.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.ocr.engines import OcrWord

__all__ = [
    "MIN_TABLE_COLUMNS",
    "MIN_TABLE_ROWS",
    "TableCell",
    "TableGrid",
    "assign_words",
    "detect_tables",
]

logger = get_logger("konusbitr.worker.parse.ocr.tables")

#: Smallest grid worth calling a table.
#:
#: Two columns, because one column of ruled boxes is a form field or a sidebar,
#: and rendering it as a table costs a citable paragraph and buys nothing. Two
#: rows, because a single ruled row is a heading banner.
MIN_TABLE_ROWS = 2
MIN_TABLE_COLUMNS = 2

#: A rule must run at least this fraction of the detected table's width (or
#: height) to count. Well below 1.0: the outer border of a table runs the whole
#: way, but an interior rule under a spanning header runs only part of it, and
#: those partial rules are exactly what says where the columns are.
_MIN_RULE_EXTENT = 0.25

#: Kernel length for the morphological pass, as a fraction of the page's width
#: (or height). A line shorter than this is not a rule.
#:
#: One thirtieth of a Letter page at 300 DPI is about 80 pixels — roughly a
#: dozen characters. Body text never produces a horizontal run that long and a
#: table rule always does, which is the whole separation this number encodes.
_RULE_KERNEL_FRACTION = 1.0 / 30.0

#: Pixels within which two detected rules are the same rule. A printed rule is
#: two or three pixels thick at 300 DPI and a scan smears it further.
_RULE_MERGE_PIXELS = 6

#: Fraction of a boundary segment that must carry ink for the boundary to exist
#: between two adjacent cells. Below it, the two cells are merged.
_SEGMENT_INK_RATIO = 0.4

#: Smallest table area, as a fraction of the page. A ruled box smaller than this
#: is a signature block or a checkbox.
_MIN_TABLE_AREA = 0.01


@dataclass(slots=True)
class TableCell:
    """One cell of a reconstructed grid, in pixels of the page it was found on."""

    row: int
    col: int
    row_span: int
    col_span: int
    #: `(x0, y0, x1, y1)`, top-left origin, y down, in pixels.
    box: tuple[float, float, float, float]
    words: list[OcrWord] = field(default_factory=list)

    @property
    def text(self) -> str:
        """The cell's words in reading order, joined.

        Ordered by line and then by x, not by detection order: a two-line cell
        whose second line was detected first would otherwise read backwards, and
        a cell is short enough that nobody would notice from the markdown.
        """
        ordered = sorted(self.words, key=lambda word: (round(word.box[1] / 8.0), word.box[0]))
        return " ".join(word.text for word in ordered if word.text).strip()

    @property
    def confidence(self) -> float:
        scores = [word.confidence for word in self.words if word.text.strip()]
        return sum(scores) / len(scores) if scores else 0.0


@dataclass(slots=True)
class TableGrid:
    """A reconstructed table: its box on the page, its shape, and its cells."""

    box: tuple[float, float, float, float]
    rows: int
    cols: int
    cells: list[TableCell] = field(default_factory=list)

    def contains(self, box: tuple[float, float, float, float]) -> bool:
        """Whether a word box's centre falls inside this table.

        The centre rather than the whole box, because a word that overhangs a
        rule by a pixel belongs to the cell it is mostly in, and requiring
        containment would drop it from the table and leave it in the prose —
        where it would be cited as a stray paragraph beside the table it came
        out of.
        """
        cx = (box[0] + box[2]) / 2.0
        cy = (box[1] + box[3]) / 2.0
        return self.box[0] <= cx <= self.box[2] and self.box[1] <= cy <= self.box[3]

    @property
    def has_content(self) -> bool:
        return any(cell.words for cell in self.cells)


def detect_tables(binary: Any) -> list[TableGrid]:
    """Find ruled tables on a binarised page and return their grids, in pixels.

    `binary` is the thresholded image :mod:`konusbitr_worker.parse.ocr.preprocess`
    already produced — ink dark, paper light, single channel. Reusing it rather
    than thresholding again is not only cheaper: it means the rules found here
    are the same strokes the fallback recogniser read, in the same frame, so a
    cell box and a word box need no reconciliation.

    Returns an empty list for a page with no ruled table on it, which is the
    overwhelmingly common case and costs two morphological passes.
    """
    try:
        import cv2
        import numpy as np
    except ImportError:  # pragma: no cover - both are hard dependencies
        return []

    if binary is None or getattr(binary, "ndim", 0) < 2:
        return []

    height, width = binary.shape[:2]
    if width <= 0 or height <= 0:
        return []

    # Ink white, paper black: every morphological operator below grows the
    # foreground, and the foreground has to be the strokes.
    ink = np.asarray(binary)
    if ink.ndim == 3:  # pragma: no cover - the preprocessor emits one channel
        ink = cv2.cvtColor(ink, cv2.COLOR_RGB2GRAY)
    ink = (ink < 128).astype("uint8") * 255

    horizontal = _rules(cv2, ink, axis=1, length=max(int(width * _RULE_KERNEL_FRACTION), 10))
    vertical = _rules(cv2, ink, axis=0, length=max(int(height * _RULE_KERNEL_FRACTION), 10))
    skeleton = cv2.bitwise_or(horizontal, vertical)

    grids: list[TableGrid] = []
    contours, _hierarchy = cv2.findContours(
        # Closed first: a scan breaks a rule into segments, and a broken border
        # is a contour per segment rather than one rectangle.
        cv2.morphologyEx(skeleton, cv2.MORPH_CLOSE, np.ones((5, 5), "uint8")),
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE,
    )
    page_area = float(width * height)
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w * h < page_area * _MIN_TABLE_AREA:
            continue
        grid = _grid_within(horizontal, vertical, (x, y, x + w, y + h))
        if grid is not None:
            grids.append(grid)

    grids.sort(key=lambda grid: (grid.box[1], grid.box[0]))
    if grids:
        logger.debug(
            "ruled tables detected",
            extra={"tables": len(grids), "shapes": [(g.rows, g.cols) for g in grids]},
        )
    return grids


def _rules(cv2: Any, ink: Any, *, axis: int, length: int) -> Any:
    """The strokes that run `length` pixels along `axis` and nothing else.

    Erode with a long thin kernel — which survives only where the stroke runs
    the whole kernel — then dilate with the same one to put the rule back to its
    original extent. The classic open, and the reason a line of text disappears
    while a table rule does not.
    """
    size = (length, 1) if axis == 1 else (1, length)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, size)
    eroded = cv2.erode(ink, kernel, iterations=1)
    return cv2.dilate(eroded, kernel, iterations=1)


def _grid_within(
    horizontal: Any, vertical: Any, box: tuple[int, int, int, int]
) -> TableGrid | None:
    """Turn the rules inside one candidate box into a grid, or reject the box."""
    x0, y0, x1, y1 = box
    rows = _rule_positions(horizontal[y0:y1, x0:x1], axis=1, extent=x1 - x0)
    cols = _rule_positions(vertical[y0:y1, x0:x1], axis=0, extent=y1 - y0)

    if len(rows) < MIN_TABLE_ROWS + 1 or len(cols) < MIN_TABLE_COLUMNS + 1:
        return None

    boundaries_y = [y0 + offset for offset in rows]
    boundaries_x = [x0 + offset for offset in cols]

    cells = _cells(horizontal, vertical, boundaries_x, boundaries_y)
    if not cells:
        return None

    return TableGrid(
        box=(
            float(boundaries_x[0]),
            float(boundaries_y[0]),
            float(boundaries_x[-1]),
            float(boundaries_y[-1]),
        ),
        rows=len(boundaries_y) - 1,
        cols=len(boundaries_x) - 1,
        cells=cells,
    )


def _rule_positions(mask: Any, *, axis: int, extent: int) -> list[int]:
    """Where the rules are, as offsets along the perpendicular axis.

    A projection profile: sum the mask along the rule's own direction, keep the
    rows (or columns) where enough of it is ink, and collapse runs of adjacent
    hits into one position. The collapse is what turns a three-pixel-thick
    printed rule into one boundary instead of three.
    """
    import numpy as np

    if mask.size == 0 or extent <= 0:
        return []

    profile = (np.asarray(mask) > 0).sum(axis=axis)
    threshold = max(int(extent * _MIN_RULE_EXTENT), 1)
    hits = [int(index) for index, value in enumerate(profile) if value >= threshold]
    if not hits:
        return []

    merged: list[int] = []
    run = [hits[0]]
    for position in hits[1:]:
        if position - run[-1] <= _RULE_MERGE_PIXELS:
            run.append(position)
        else:
            merged.append(sum(run) // len(run))
            run = [position]
    merged.append(sum(run) // len(run))
    return merged


def _cells(
    horizontal: Any,
    vertical: Any,
    boundaries_x: list[int],
    boundaries_y: list[int],
) -> list[TableCell]:
    """Build the cells, merging across boundaries that carry no rule.

    Walks the base grid top-left to bottom-right. A base cell already claimed by
    a span is skipped; otherwise the span is grown right for as long as the
    vertical rule to its right is missing, then down for as long as the
    horizontal rule beneath it is missing across that whole width.
    """
    rows = len(boundaries_y) - 1
    cols = len(boundaries_x) - 1
    claimed = [[False] * cols for _ in range(rows)]
    cells: list[TableCell] = []

    for row in range(rows):
        for col in range(cols):
            if claimed[row][col]:
                continue

            col_span = 1
            while col + col_span < cols and not _has_vertical_rule(
                vertical,
                x=boundaries_x[col + col_span],
                y0=boundaries_y[row],
                y1=boundaries_y[row + 1],
            ):
                col_span += 1

            row_span = 1
            while row + row_span < rows and not _has_horizontal_rule(
                horizontal,
                y=boundaries_y[row + row_span],
                x0=boundaries_x[col],
                x1=boundaries_x[col + col_span],
            ):
                row_span += 1

            for dy in range(row_span):
                for dx in range(col_span):
                    claimed[row + dy][col + dx] = True

            cells.append(
                TableCell(
                    row=row,
                    col=col,
                    row_span=row_span,
                    col_span=col_span,
                    box=(
                        float(boundaries_x[col]),
                        float(boundaries_y[row]),
                        float(boundaries_x[col + col_span]),
                        float(boundaries_y[row + row_span]),
                    ),
                )
            )
    return cells


def _has_vertical_rule(vertical: Any, *, x: int, y0: int, y1: int) -> bool:
    import numpy as np

    if y1 <= y0:
        return True
    window = np.asarray(vertical)[y0:y1, max(x - 2, 0) : x + 3]
    if window.size == 0:
        return True
    covered = (window > 0).any(axis=1).sum()
    return bool(covered >= (y1 - y0) * _SEGMENT_INK_RATIO)


def _has_horizontal_rule(horizontal: Any, *, y: int, x0: int, x1: int) -> bool:
    import numpy as np

    if x1 <= x0:
        return True
    window = np.asarray(horizontal)[max(y - 2, 0) : y + 3, x0:x1]
    if window.size == 0:
        return True
    covered = (window > 0).any(axis=0).sum()
    return bool(covered >= (x1 - x0) * _SEGMENT_INK_RATIO)


def assign_words(grids: list[TableGrid], words: list[OcrWord]) -> list[OcrWord]:
    """Drop each word into the cell it sits in; return the words no table claimed.

    The leftovers are what :mod:`konusbitr_worker.parse.ocr.layout` groups into
    paragraphs. Partitioning rather than copying is the point: a number that
    appears in both a table chunk and a prose chunk is retrieved twice and cited
    from whichever won, and the two citations point at different rectangles.
    """
    if not grids:
        return list(words)

    leftover: list[OcrWord] = []
    for word in words:
        cell = _cell_for(grids, word)
        if cell is None:
            leftover.append(word)
        else:
            cell.words.append(word)
    return leftover


def _cell_for(grids: list[TableGrid], word: OcrWord) -> TableCell | None:
    cx = (word.box[0] + word.box[2]) / 2.0
    cy = (word.box[1] + word.box[3]) / 2.0
    for grid in grids:
        if not grid.contains(word.box):
            continue
        for cell in grid.cells:
            if cell.box[0] <= cx <= cell.box[2] and cell.box[1] <= cy <= cell.box[3]:
                return cell
        # Inside the table's outer rectangle but in none of its cells — the
        # margin between the border and the first rule. Kept out of the prose
        # anyway: it is part of the table's furniture, not a paragraph.
        return _nearest_cell(grid, cx, cy)
    return None


def _nearest_cell(grid: TableGrid, cx: float, cy: float) -> TableCell | None:
    best: TableCell | None = None
    best_distance = float("inf")
    for cell in grid.cells:
        dx = max(cell.box[0] - cx, 0.0, cx - cell.box[2])
        dy = max(cell.box[1] - cy, 0.0, cy - cell.box[3])
        distance = dx * dx + dy * dy
        if distance < best_distance:
            best, best_distance = cell, distance
    return best
