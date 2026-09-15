"""The parse artifact: what the pipeline produces and `parse_results.contents` stores.

This shape is the contract between the parser and everything downstream of it —
Phase 08 chunks `contents`, Phase 11 draws `bbox`, Phase 13's `extract` reads
`tableJson`. It is deliberately a *normalized* structure rather than a dump of
whatever Docling returned: the parser is replaceable (Phase 12 adds a VLM tier)
and the artifact is not.

It is JSON, not a pydantic model on the wire, because it never crosses the
TypeScript ↔ Python seam as a message — it crosses it through Postgres, as a
`jsonb` column that TypeScript reads and this service writes. The dataclasses
here exist so that the writer has one place to get the field names right.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from konusbitr_worker.parse.geometry import BBox

__all__ = [
    "ElementType",
    "PageTier",
    "ParseArtifact",
    "ParsedElement",
    "ParsedPage",
    "TableCellData",
    "TableData",
    "markdown_table",
]


class PageTier(StrEnum):
    """How a page's text was obtained.

    The tier is a property of the *page*, not of the document, and that is the
    whole of Phase 12.1's first idea. A hundred-page filing with three scanned
    exhibits is not a scanned document and not a digital one; tiering it as
    either means ninety-seven pages of needless OCR or three pages of silence.

    It is also the honest answer to a question a reader is entitled to ask. Text
    that came out of a font is what the author typed; text that came out of a
    recogniser is a machine's best reading of a photograph, and a citation
    against it deserves to say so. `pages.tier` and `pages.ocr_confidence` are
    what the viewer badges from.
    """

    #: A real text layer, read by Docling. No recogniser involved.
    native = "native"
    #: Recognised from a raster by :mod:`konusbitr_worker.parse.ocr`.
    ocr = "ocr"
    #: Reconstructed by a vision model. Phase 12.3; declared here so that the
    #: column's vocabulary does not change when it arrives.
    vlm = "vlm"


class ElementType(StrEnum):
    """The element vocabulary, fixed by the Phase 07 artifact specification.

    Small on purpose. Docling distinguishes many more label types than this,
    and every extra one is a case that Phase 08's chunker and Phase 11's viewer
    both have to handle. Anything unrecognised becomes `paragraph`, which is
    the reading every downstream consumer already handles correctly.
    """

    heading = "heading"
    paragraph = "paragraph"
    table = "table"
    list = "list"
    figure = "figure"
    caption = "caption"
    footnote = "footnote"


@dataclass(slots=True)
class TableCellData:
    """One cell, addressable by position and locatable on the page.

    Added in Phase 12.2, and the part that is genuinely new is `bbox`. Headers
    and rows say what a table *contains*; a cell box says where a number is, and
    without it "cite the 2024 revenue figure" can only ever highlight the whole
    table. On a scanned page the cell box is also the only honest answer — the
    table was reconstructed from ruling lines and word boxes, and the reader is
    entitled to see the rectangle a value was read out of.

    `row_index` counts the header row as row 0, matching `rows` being the data
    rows alone: a consumer that wants the header cell of a column looks for
    `row_index == 0`.
    """

    row_index: int
    col_index: int
    text: str
    #: `None` when the source located the table but not its individual cells.
    bbox: BBox | None = None
    row_span: int = 1
    col_span: int = 1
    #: True for a cell in a declared header row or column.
    header: bool = False

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "rowIndex": self.row_index,
            "colIndex": self.col_index,
            "text": self.text,
        }
        if self.bbox is not None:
            payload["bbox"] = self.bbox.as_list()
        # Spans are emitted only when they are not 1, so an ordinary table's
        # JSON is not two thirds boilerplate. A reader that sees no `rowSpan`
        # reads 1, which is what every consumer already assumes.
        if self.row_span != 1:
            payload["rowSpan"] = self.row_span
        if self.col_span != 1:
            payload["colSpan"] = self.col_span
        if self.header:
            payload["header"] = True
        return payload


@dataclass(slots=True)
class TableData:
    """A table as data, alongside the same table as markdown.

    Both representations are kept because they answer different questions. The
    markdown is what the LLM reads in context, where a pipe table is worth far
    more than a JSON blob. The JSON is what Phase 13's `extract` reads, where
    "the value in the Revenue row of the 2024 column" has to be addressable
    without re-parsing prose.
    """

    headers: list[str]
    rows: list[list[str]]
    #: Cell-level detail, when the source produced any. Empty is a supported
    #: state and not a degraded one: `headers` and `rows` are the contract, and
    #: a parser that knows the grid but not where each cell sits still produces
    #: a table Phase 13 can address.
    cells: list[TableCellData] = field(default_factory=list)

    @property
    def num_rows(self) -> int:
        """Rows including the header row, which is what `rowIndex` counts in."""
        return len(self.rows) + (1 if self.headers else 0)

    @property
    def num_cols(self) -> int:
        widths = [len(self.headers), *(len(row) for row in self.rows)]
        return max(widths) if widths else 0

    def to_json(self) -> dict[str, Any]:
        return {
            "numRows": self.num_rows,
            "numCols": self.num_cols,
            "headers": self.headers,
            "rows": self.rows,
            "cells": [cell.to_json() for cell in self.cells],
        }


@dataclass(slots=True)
class ParsedElement:
    """One element of the document, in reading order, with a place on a page."""

    id: str
    type: ElementType
    text: str
    markdown: str
    page: int
    bbox: BBox
    #: The heading trail above this element, outermost first. Phase 08 puts it
    #: in the chunk header so a passage retrieved on its own still says where
    #: in the document it came from.
    section_path: list[str] = field(default_factory=list)
    #: Headings only; `None` everywhere else.
    level: int | None = None
    table: TableData | None = None

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "type": self.type.value,
            "text": self.text,
            "markdown": self.markdown,
            "page": self.page,
            "bbox": self.bbox.as_list(),
            "sectionPath": list(self.section_path),
        }
        if self.level is not None:
            payload["level"] = self.level
        if self.table is not None:
            payload["tableJson"] = self.table.to_json()
        return payload


@dataclass(slots=True)
class ParsedPage:
    """A page's geometry, in the visible (rotation-applied) frame."""

    page_no: int
    width: float
    height: float
    rotation: int = 0
    #: Storage key of the WebP thumbnail, once one has been written.
    thumbnail_key: str | None = None
    #: How this page's text was obtained. See :class:`PageTier`.
    tier: PageTier = PageTier.native
    #: `0.0`-`1.0` for a recognised page; `None` for a native one.
    #:
    #: `None` rather than `1.0`, and the distinction is not pedantic. A native
    #: page has no confidence because nothing guessed: the characters are the
    #: ones in the file. Storing `1.0` would make "how confident are we in this
    #: page?" a question with an answer on every page, and the honest answer on
    #: a born-digital page is that it is not a question.
    ocr_confidence: float | None = None
    #: Which recogniser produced the text, when one did. Diagnostic.
    ocr_engine: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "pageNo": self.page_no,
            "width": round(self.width, 2),
            "height": round(self.height, 2),
            "rotation": self.rotation,
            "thumbnailKey": self.thumbnail_key,
            "tier": self.tier.value,
            "ocrConfidence": (
                None if self.ocr_confidence is None else round(self.ocr_confidence, 4)
            ),
            "ocrEngine": self.ocr_engine,
        }


@dataclass(slots=True)
class ParseArtifact:
    """The whole parse: markdown for the model, elements for the citation machinery."""

    markdown: str
    page_count: int
    contents: list[ParsedElement] = field(default_factory=list)
    pages: list[ParsedPage] = field(default_factory=list)
    #: Extracted figure images. Populated in Phase 12; present now so that the
    #: shape a consumer reads does not change when it is.
    images: list[dict[str, Any]] = field(default_factory=list)
    #: Per-stage wall-clock milliseconds, for the performance budget. Diagnostic
    #: only: nothing branches on it, and it is safe to log.
    timings: dict[str, int] = field(default_factory=dict)

    def to_json(self, *, include_markdown: bool = True) -> dict[str, Any]:
        """The artifact as JSON.

        `include_markdown` is false when this is written to
        `parse_results.contents`, because `parse_results.markdown` is the same
        string in its own column — and a document's markdown is by far the
        largest thing here, so storing it twice would roughly double the row
        for nothing. Every other consumer gets the whole artifact.
        """
        payload: dict[str, Any] = {
            "pageCount": self.page_count,
            "contents": [element.to_json() for element in self.contents],
            "pages": [page.to_json() for page in self.pages],
            "images": list(self.images),
            "timings": dict(self.timings),
        }
        if include_markdown:
            payload["markdown"] = self.markdown
        return payload


def markdown_table(headers: list[str], rows: list[list[str]]) -> str:
    """Render a table as GitHub-flavoured markdown.

    One renderer for both tiers. Docling exports its own markdown for a
    born-digital table and that export is better than this — it knows about
    cells containing line breaks — so this is that path's fallback and the OCR
    tier's only path, and having one function means a scanned table and a parsed
    one reach the model in the same shape.

    Pipes inside a cell are escaped, because an unescaped one silently adds a
    column and shifts every value in the row one place to the left, which is a
    wrong number rather than a broken table.
    """
    width = max(len(headers), *(len(row) for row in rows), 0)
    if width == 0:
        return ""

    def line(cells: list[str]) -> str:
        padded = [*cells, *([""] * (width - len(cells)))]
        return (
            "| " + " | ".join(cell.replace("|", "\\|").replace("\n", " ") for cell in padded) + " |"
        )

    head = headers if headers else [""] * width
    return "\n".join(
        [
            line(head),
            "| " + " | ".join("---" for _ in range(width)) + " |",
            *(line(row) for row in rows),
        ]
    )


def element_id(index: int) -> str:
    """`el_0007`. Zero-padded so that a lexical sort is a reading-order sort."""
    return f"el_{index:04d}"


def markdown_from_elements(elements: list[ParsedElement]) -> str:
    """Compose a document's markdown from its elements, in reading order.

    Used when a document has pages from more than one tier. Docling's own
    `export_to_markdown` is better than this — it knows about nested lists and
    about captions belonging to the figure above them — so a wholly native
    document keeps using it, unchanged from Phase 07. But Docling's export
    covers only what Docling parsed, and on a mixed document that is the digital
    pages alone: a markdown built that way would silently omit the scanned
    exhibits from everything downstream that reads it, which is the summary, the
    corpus-level retrieval index, and any answer the model draws from the
    document as a whole.

    Each element already carries its own markdown — a heading with its hashes, a
    list item with its bullet, a table as a pipe table — so composing is joining
    them with blank lines.
    """
    return "\n\n".join(element.markdown.strip() for element in elements if element.markdown.strip())
