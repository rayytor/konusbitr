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

__all__ = ["ElementType", "ParseArtifact", "ParsedElement", "ParsedPage", "TableData"]


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

    def to_json(self) -> dict[str, Any]:
        return {"headers": self.headers, "rows": self.rows}


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

    def to_json(self) -> dict[str, Any]:
        return {
            "pageNo": self.page_no,
            "width": round(self.width, 2),
            "height": round(self.height, 2),
            "rotation": self.rotation,
            "thumbnailKey": self.thumbnail_key,
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


def element_id(index: int) -> str:
    """`el_0007`. Zero-padded so that a lexical sort is a reading-order sort."""
    return f"el_{index:04d}"
