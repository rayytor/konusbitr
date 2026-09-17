"""Docling, and the normalization of what it returns into the Konusbitr artifact.

Docling is the primary parser because of the one property this product cannot
do without: it emits layout-aware structure with first-class bounding boxes and
a reading order, rather than a stream of text with the geometry thrown away. It
is MIT-licensed, so it belongs in the default build rather than behind the
`advanced` profile.

Everything Docling-shaped stops at this module. Downstream code — the chunker
in Phase 08, the viewer in Phase 11 — sees only
:class:`konusbitr_worker.parse.artifact.ParseArtifact`, which is why Phase 12
can add a VLM tier beside this one without touching either.

The import is deliberately lazy. Docling drags in torch and a layout model;
importing it at module scope would make `python -m konusbitr_worker.health`,
the settings tests and the contract tests all pay several seconds for something
they never call.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from konusbitr_worker.contracts import JobErrorCode
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.artifact import (
    ElementType,
    ParsedElement,
    TableCellData,
    TableData,
    element_id,
    markdown_table,
)
from konusbitr_worker.parse.geometry import BBox, CoordOrigin, PageGeometry

__all__ = ["DoclingParse", "build_converter", "convert", "normalize_items"]

logger = get_logger("konusbitr.worker.parse.docling")

#: Docling's PDF backends report provenance on the page **as a reader sees it**:
#: the backend applies `/Rotate` when it lays the page out, and `doc.pages[n].size`
#: is the rotated size to match. So the rotation must *not* be applied a second
#: time here. `tests/test_parse_fixtures.py` pins this against a fixture with a
#: rotated page, because a wrong answer is invisible on a square figure and
#: glaring on a line of text — and this constant is the thing to flip if a
#: future Docling changes its mind.
DOCLING_REPORTS_ROTATED_FRAME = True

#: Docling labels mapped onto the seven element types the artifact defines.
#: Anything absent becomes `paragraph`; see :class:`ElementType`.
_LABEL_TO_TYPE: dict[str, ElementType] = {
    "title": ElementType.heading,
    "section_header": ElementType.heading,
    "paragraph": ElementType.paragraph,
    "text": ElementType.paragraph,
    "code": ElementType.paragraph,
    "formula": ElementType.paragraph,
    "reference": ElementType.paragraph,
    "list_item": ElementType.list,
    "table": ElementType.table,
    "document_index": ElementType.table,
    "picture": ElementType.figure,
    "chart": ElementType.figure,
    "caption": ElementType.caption,
    "footnote": ElementType.footnote,
}

#: Labels that carry no content a reader or a retriever wants. Running headers
#: and page numbers repeat on every page; as chunks they are noise that
#: retrieval scores highly precisely because they recur.
_SKIPPED_LABELS = {"page_header", "page_footer"}


@dataclass(slots=True)
class DoclingParse:
    """What :func:`convert` produces: markdown, elements, and nothing Docling-shaped."""

    markdown: str
    contents: list[ParsedElement]


def build_converter(threads: int) -> Any:
    """A configured `DocumentConverter`, built once and reused for a document.

    Split out of :func:`convert` for the batched pipeline. A 900-page document
    is parsed sixteen pages at a time, and a converter constructed per batch
    would reload TableFormer's weights fifty-six times — seconds each, for a
    result identical to keeping the object. The converter holds models, not
    document state, so reusing one across batches of the same document is safe
    and reusing one across *documents* would be too; it is scoped to a document
    only because that is the lifetime the caller already manages.
    """
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    # Docling's own OCR stays off. The OCR tier is
    # :mod:`konusbitr_worker.parse.ocr`, which runs the engines directly so that
    # it can keep word-level boxes, a per-page confidence and the deskew
    # transform — none of which survive Docling's text-cell abstraction, and all
    # three of which are Phase 12.1 acceptance criteria. See
    # `docs/adr/0005-ocr.md`.
    options.do_ocr = False
    options.do_table_structure = True
    options.table_structure_options.do_cell_matching = True
    options.generate_page_images = False
    options.generate_picture_images = False
    # Docling's threaded stages default to a 500ms polling sleep when a batch
    # is not full. For a multi-page document across multiple stages, that polling
    # delay adds seconds of pure idle time. A 10ms interval keeps stages moving.
    options.batch_polling_interval_seconds = 0.01
    # The bounded pool the budget depends on. Docling parallelises page
    # processing internally; oversubscribing the cores makes a 50-page document
    # slower rather than faster.
    options.accelerator_options.num_threads = threads

    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
    )


def convert(
    path: Path,
    *,
    geometries: dict[int, PageGeometry],
    threads: int,
    native_pages: set[int] | None = None,
    converter: Any | None = None,
) -> DoclingParse:
    """Run Docling over a PDF and normalize the result. Synchronous and CPU-bound.

    `geometries` comes from the structural pass in
    :mod:`konusbitr_worker.parse.inspect` and is what every bbox is measured
    against — PDFium's view of the page, not Docling's. Two libraries agreeing
    on a page size is not something to assume, and the `pages` row a viewer
    scales by is written from PDFium's answer.

    `native_pages` is the set of pages the inspection tiered as born-digital.
    Anything Docling emits for a page outside it is dropped, because on a
    scanned page Docling's text layer is a running header, a stamped page
    number, or nothing — and the recogniser's reading of that page is about to
    replace it. Two readings of one page in `contents` would be cited twice and
    retrieved twice.

    The set also narrows what Docling is asked to open. Docling takes a
    contiguous `page_range` rather than a set, so the span from the first to the
    last native page is the most that can be skipped — which happens to be the
    common shape: a born-digital filing with scanned exhibits stapled to the
    back. A document with one scanned page in the middle saves nothing here, and
    the element filter is what keeps it correct.
    """
    converter = converter or build_converter(threads)

    try:
        result = converter.convert(str(path), **_page_range(native_pages))
    except JobFailure:
        raise
    except Exception as error:
        # Docling raising on a file PDFium opened cleanly is a parser problem,
        # not a file problem, so it is `internal` and therefore retryable. A
        # genuinely broken file has already been refused by the structural pass.
        logger.exception("docling conversion failed")
        raise JobFailure(
            JobErrorCode.internal,
            "That document could not be parsed.",
        ) from error

    document = result.document
    contents = normalize_items(document, geometries=geometries)
    if native_pages is not None:
        contents = [element for element in contents if element.page in native_pages]
    return DoclingParse(
        markdown=document.export_to_markdown(),
        contents=contents,
    )


def _page_range(native_pages: set[int] | None) -> dict[str, tuple[int, int]]:
    """The contiguous span Docling is asked to open, when narrowing it is safe.

    Empty when every page is native (Docling's own default covers the document)
    and empty when no page is — a caller with nothing for Docling to do should
    not be calling it at all, and returning a degenerate range here would hide
    that mistake behind a parse of page one.
    """
    if not native_pages:
        return {}
    first, last = min(native_pages), max(native_pages)
    return {"page_range": (first, last)}


def normalize_items(document: Any, *, geometries: dict[int, PageGeometry]) -> list[ParsedElement]:
    """Walk a `DoclingDocument` in reading order and emit artifact elements.

    Split out from :func:`convert` so that the normalization — which is where
    the coordinate convention and the element vocabulary are actually decided —
    can be tested against a constructed document without running a parser.
    """
    elements: list[ParsedElement] = []
    #: The open heading trail, as (level, text) outermost first.
    section_stack: list[tuple[int, str]] = []

    for item, _depth in document.iterate_items():
        label = _label_of(item)
        if label in _SKIPPED_LABELS:
            continue

        placement = _placement(item, geometries)
        if placement is None:
            # No provenance means no page and no box, and an element that
            # cannot be pointed at cannot be cited. Dropping it is better than
            # storing a citation target that the viewer would have to guess at.
            continue
        page_no, bbox = placement

        element_type = _LABEL_TO_TYPE.get(label, ElementType.paragraph)
        text, markdown, table = _render(item, document, element_type, geometries.get(page_no))
        if not text.strip() and table is None and element_type is not ElementType.figure:
            continue

        level: int | None = None
        if element_type is ElementType.heading:
            level = _heading_level(item, label)
            _push_heading(section_stack, level, text)

        elements.append(
            ParsedElement(
                id=element_id(len(elements)),
                type=element_type,
                text=text,
                markdown=markdown,
                page=page_no,
                bbox=bbox,
                # The trail *above* this element: a heading is not inside
                # itself, so its own entry is excluded.
                section_path=[
                    heading for depth, heading in section_stack if level is None or depth < level
                ],
                level=level,
                table=table,
            )
        )

    return elements


def _label_of(item: Any) -> str:
    label = getattr(item, "label", None)
    return str(getattr(label, "value", label) or "").lower()


def _placement(item: Any, geometries: dict[int, PageGeometry]) -> tuple[int, BBox] | None:
    """The page and normalized box of an item's first provenance entry.

    First rather than merged: an element that spans a page break has its
    provenance recorded once per page, and a box merged across two pages would
    be a rectangle that exists on neither. The citation points at where the
    element starts, which is where a reader would want to land.
    """
    provenance = list(getattr(item, "prov", None) or [])
    if not provenance:
        return None

    first = provenance[0]
    page_no = int(getattr(first, "page_no", 0) or 0)
    geometry = geometries.get(page_no)
    raw = getattr(first, "bbox", None)
    if geometry is None or raw is None:
        return None

    bbox = geometry.normalize(
        (float(raw.l), float(raw.t), float(raw.r), float(raw.b)),
        origin=_origin_of(raw),
        rotated=DOCLING_REPORTS_ROTATED_FRAME,
    )
    if bbox.is_degenerate:
        return None
    return page_no, bbox


def _origin_of(bbox: Any) -> CoordOrigin:
    """Which way this box's y axis points, as Docling itself reports it."""
    origin = str(getattr(getattr(bbox, "coord_origin", None), "value", "")).upper()
    return CoordOrigin.top_left if origin == "TOPLEFT" else CoordOrigin.bottom_left


def _heading_level(item: Any, label: str) -> int:
    """1 for a document title, otherwise what Docling says, clamped to h1-h6."""
    if label == "title":
        return 1
    level = getattr(item, "level", None)
    try:
        return max(1, min(int(level), 6))
    except (TypeError, ValueError):
        return 2


def _push_heading(stack: list[tuple[int, str]], level: int, text: str) -> None:
    """Open a new section, closing every section at or below its level."""
    while stack and stack[-1][0] >= level:
        stack.pop()
    stack.append((level, text.strip()))


def _render(
    item: Any, document: Any, element_type: ElementType, geometry: PageGeometry | None = None
) -> tuple[str, str, TableData | None]:
    """An element's plain text, its own markdown, and its table data if it is one."""
    if element_type is ElementType.table:
        table = _table_data(item, geometry)
        markdown = _table_markdown(item, document, table)
        # A table's "text" is its markdown: the cells are the content, and a
        # concatenation of them with the row structure discarded would embed
        # into something that retrieves for every number in the document.
        return markdown, markdown, table

    text = str(getattr(item, "text", "") or "").strip()

    if element_type is ElementType.heading:
        level = _heading_level(item, _label_of(item))
        return text, f"{'#' * level} {text}".rstrip(), None
    if element_type is ElementType.list:
        return text, f"- {text}" if text else "", None
    if element_type is ElementType.figure:
        caption = _caption_of(item, document)
        return caption, f"![{caption}]()" if caption else "![]()", None
    return text, text, None


def _caption_of(item: Any, document: Any) -> str:
    getter = getattr(item, "caption_text", None)
    if callable(getter):
        try:
            return str(getter(document) or "").strip()
        except Exception:  # pragma: no cover - a caption is never load-bearing
            return ""
    return ""


def _table_data(item: Any, geometry: PageGeometry | None = None) -> TableData | None:
    """Docling's table cells, flattened into headers plus rows, plus the cells themselves.

    The grid is the source rather than the dataframe export: a dataframe would
    add pandas to the dependency set for a shape we immediately flatten back
    into strings, and it coerces cell values to types the original document
    never claimed.

    `geometry` is what turns Docling's cell boxes into the Konusbitr convention.
    It is optional because a table is still a table without per-cell boxes — an
    older Docling, or a cell with no provenance, simply contributes no `bbox` —
    and losing the whole table over a missing rectangle would be the wrong
    trade. What the boxes buy is a citation that lands on *the number* rather
    than on the table containing it.
    """
    data = getattr(item, "data", None)
    grid = getattr(data, "grid", None)
    if not grid:
        return None

    rows: list[list[str]] = [
        [str(getattr(cell, "text", "") or "").strip() for cell in row] for row in grid
    ]
    if not rows:
        return None

    first_row_cells = list(grid[0])
    header_row = all(bool(getattr(cell, "column_header", False)) for cell in first_row_cells)
    cells = _table_cells(data, grid, geometry)

    if header_row:
        return TableData(headers=rows[0], rows=rows[1:], cells=cells)
    # No declared header row. An empty `headers` says so honestly; inventing
    # one from the first row of data would put a value where a column name goes
    # and Phase 13's `extract` would address the wrong cell.
    return TableData(headers=[], rows=rows, cells=cells)


def _table_cells(data: Any, grid: Any, geometry: PageGeometry | None) -> list[TableCellData]:
    """Every distinct cell of a Docling table, once, with its box where there is one.

    `data.table_cells` rather than the grid, because the grid repeats a spanning
    cell into every position it covers — which is what a markdown renderer wants
    and exactly what a list of cells must not do, since a merged header would
    otherwise appear three times with three identical boxes.
    """
    source = getattr(data, "table_cells", None)
    if not source:
        source = [cell for row in grid for cell in row]
        seen: set[tuple[int, int]] = set()
        deduped = []
        for cell in source:
            key = (
                int(getattr(cell, "start_row_offset_idx", 0) or 0),
                int(getattr(cell, "start_col_offset_idx", 0) or 0),
            )
            if key in seen:
                continue
            seen.add(key)
            deduped.append(cell)
        source = deduped

    cells: list[TableCellData] = []
    for cell in source:
        text = str(getattr(cell, "text", "") or "").strip()
        if not text:
            continue
        row = int(getattr(cell, "start_row_offset_idx", 0) or 0)
        col = int(getattr(cell, "start_col_offset_idx", 0) or 0)
        row_end = int(getattr(cell, "end_row_offset_idx", row + 1) or row + 1)
        col_end = int(getattr(cell, "end_col_offset_idx", col + 1) or col + 1)

        cells.append(
            TableCellData(
                row_index=row,
                col_index=col,
                text=text,
                bbox=_cell_bbox(cell, geometry),
                row_span=max(row_end - row, 1),
                col_span=max(col_end - col, 1),
                header=bool(getattr(cell, "column_header", False)),
            )
        )
    return cells


def _cell_bbox(cell: Any, geometry: PageGeometry | None) -> BBox | None:
    """One cell's box in the Konusbitr convention, or `None` when it has none."""
    raw = getattr(cell, "bbox", None)
    if raw is None or geometry is None:
        return None
    try:
        box = (float(raw.l), float(raw.t), float(raw.r), float(raw.b))
    except (AttributeError, TypeError, ValueError):
        return None
    bbox = geometry.normalize(box, origin=_origin_of(raw), rotated=DOCLING_REPORTS_ROTATED_FRAME)
    return None if bbox.is_degenerate else bbox


def _table_markdown(item: Any, document: Any, table: TableData | None) -> str:
    """Docling's own markdown for the table, with a hand-rolled fallback.

    The table has to survive as markdown *and* as JSON — the model reads the
    first in context, Phase 13's `extract` addresses cells in the second — and
    a table is never split across elements, so both live on one entry.
    """
    exporter = getattr(item, "export_to_markdown", None)
    if callable(exporter):
        for attempt in ((document,), ()):
            try:
                rendered = str(exporter(*attempt) or "").strip()
            except TypeError:
                continue
            except Exception:  # pragma: no cover - fall through to the fallback
                break
            if rendered:
                return rendered

    if table is None:
        return ""
    return markdown_table(table.headers, table.rows)
