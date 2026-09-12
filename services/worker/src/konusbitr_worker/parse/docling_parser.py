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
    TableData,
    element_id,
)
from konusbitr_worker.parse.geometry import BBox, CoordOrigin, PageGeometry

__all__ = ["DoclingParse", "convert", "normalize_items"]

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


def convert(path: Path, *, geometries: dict[int, PageGeometry], threads: int) -> DoclingParse:
    """Run Docling over a PDF and normalize the result. Synchronous and CPU-bound.

    `geometries` comes from the structural pass in
    :mod:`konusbitr_worker.parse.inspect` and is what every bbox is measured
    against — PDFium's view of the page, not Docling's. Two libraries agreeing
    on a page size is not something to assume, and the `pages` row a viewer
    scales by is written from PDFium's answer.
    """
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    # Phase 07 is text PDFs. OCR and picture description are the `advanced`
    # tier's job in Phase 12, and leaving them on here would quietly turn the
    # `needs_ocr` refusal into a slow, low-quality parse.
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

    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
    )

    try:
        result = converter.convert(str(path))
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
    return DoclingParse(
        markdown=document.export_to_markdown(),
        contents=normalize_items(document, geometries=geometries),
    )


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
        text, markdown, table = _render(item, document, element_type)
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
    item: Any, document: Any, element_type: ElementType
) -> tuple[str, str, TableData | None]:
    """An element's plain text, its own markdown, and its table data if it is one."""
    if element_type is ElementType.table:
        table = _table_data(item)
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


def _table_data(item: Any) -> TableData | None:
    """Docling's table cells, flattened into headers plus rows.

    The grid is the source rather than the dataframe export: a dataframe would
    add pandas to the dependency set for a shape we immediately flatten back
    into strings, and it coerces cell values to types the original document
    never claimed.
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
    if header_row:
        return TableData(headers=rows[0], rows=rows[1:])
    # No declared header row. An empty `headers` says so honestly; inventing
    # one from the first row of data would put a value where a column name goes
    # and Phase 13's `extract` would address the wrong cell.
    return TableData(headers=[], rows=rows)


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
    header = table.headers or [""] * (len(table.rows[0]) if table.rows else 0)
    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join("---" for _ in header) + " |",
        *("| " + " | ".join(row) + " |" for row in table.rows),
    ]
    return "\n".join(lines)
