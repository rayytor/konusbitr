"""The chunker's input: a parse artifact's `contents`, as plain data.

The chunker reads the artifact's **JSON**, not the parser's dataclasses. That is
deliberate and it is what makes one of this phase's acceptance criteria
possible: a cached parse comes back out of ``parse_results.contents`` as exactly
the same JSON the parser would have produced, so re-chunking a document whose
bytes were parsed weeks ago runs the identical code path with no Docling, no
model load and no thumbnail render. If the chunker took `ParsedElement` objects,
that path would need a second deserialiser nobody would keep in step.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

__all__ = ["FIGURE_CHUNK_TEMPLATE", "SourceElement", "elements_from_contents", "figure_elements"]

#: Element types, matching `ElementType` in the parse artifact. Anything
#: unrecognised is read as `paragraph`, which is the reading every consumer
#: already handles correctly.
_KNOWN_TYPES = frozenset({"heading", "paragraph", "table", "list", "figure", "caption", "footnote"})


#: How a captioned figure reads once it is in the index.
#:
#: The marker is in the chunk *text* and not only in its metadata, for the same
#: reason `TRUNCATION_MARKER` is: whatever reads the passage — a model composing
#: an answer, a person following a citation — has to be able to tell that it is
#: reading a description of a picture rather than a sentence somebody wrote.
FIGURE_CHUNK_TEMPLATE = "[Figure: {caption}]"


@dataclass(frozen=True, slots=True)
class SourceElement:
    """One located element of a document, in reading order."""

    #: Position in the artifact's `contents`, so that chunks built out of
    #: separate streams — prose, tables and figures are chunked apart — can be
    #: put back into reading order before their ordinals are assigned.
    #:
    #: A float, which looks odd for an index and is not one. A figure does not
    #: come from `contents` at all — it comes from the artifact's `images` — so
    #: it has no position in that array, and the only honest answer to "where in
    #: the document is it?" is "just after the last element on its page". A half
    #: step expresses that without renumbering anything.
    order: float
    id: str
    type: str
    text: str
    markdown: str
    page: int
    bbox: tuple[float, float, float, float]
    #: The heading trail above this element, outermost first. A heading's own
    #: trail excludes itself.
    section_path: tuple[str, ...]
    #: Headings only; `None` everywhere else.
    level: int | None = None
    table_json: dict[str, Any] | None = None

    @property
    def is_table(self) -> bool:
        return self.type == "table"

    @property
    def is_heading(self) -> bool:
        return self.type == "heading"

    @property
    def is_figure(self) -> bool:
        return self.type == "figure"

    def part(self, suffix: int | str, text: str, markdown: str) -> SourceElement:
        """A slice of an oversized element, carrying its location unchanged.

        The location is the whole element's box, not a computed sub-box. A
        5,000-token paragraph has one rectangle in the parse artifact, and
        inventing a tighter one for each slice would be a coordinate the parser
        never produced — which is exactly what `docs/coordinates.md` forbids.
        Highlighting the whole paragraph for a quote inside it is honest;
        highlighting a guess is not.
        """
        return replace(self, id=f"{self.id}#{suffix}", text=text, markdown=markdown)


def elements_from_contents(contents: Any) -> list[SourceElement]:
    """Read the `contents` array of a parse artifact.

    Tolerant on the way in, because the same function reads a freshly produced
    artifact and a row written by an older build of the worker: a missing
    `sectionPath`, an absent `level`, a `bbox` of the wrong length are all
    treated as "this element is less located than it should be" rather than as
    a reason to fail a job. An element with no usable bbox is dropped, since a
    chunk built from it could not be cited.
    """
    if isinstance(contents, dict):
        contents = contents.get("contents", [])
    if not isinstance(contents, list):
        return []

    elements: list[SourceElement] = []
    for index, raw in enumerate(contents):
        if not isinstance(raw, dict):
            continue

        bbox = _bbox(raw.get("bbox"))
        page = raw.get("page")
        if bbox is None or not isinstance(page, int) or page < 1:
            continue

        text = str(raw.get("text") or "")
        markdown = str(raw.get("markdown") or text)
        kind = str(raw.get("type") or "paragraph")

        elements.append(
            SourceElement(
                order=float(index),
                id=str(raw.get("id") or f"el_{index:04d}"),
                type=kind if kind in _KNOWN_TYPES else "paragraph",
                text=text,
                markdown=markdown,
                page=page,
                bbox=bbox,
                section_path=tuple(
                    str(part) for part in (raw.get("sectionPath") or ()) if str(part).strip()
                ),
                level=raw["level"] if isinstance(raw.get("level"), int) else None,
                table_json=raw.get("tableJson") if isinstance(raw.get("tableJson"), dict) else None,
            )
        )
    return elements


def figure_elements(contents: Any) -> list[SourceElement]:
    """Read the `images` array of a parse artifact as chunkable elements.

    This is the Phase 08 bridge the figure work needed: a chart is extracted and
    captioned during the parse, and it becomes retrievable here, as a chunk of
    its own carrying the figure's page and its rectangle. Ask "which region grew
    fastest in Q3?" and the chunk that answers is the description of the bar
    chart, and the citation points at the chart.

    Only captioned figures are returned. An uncaptioned one — no vision model
    configured, `llm` not set, a provider that failed — has no text to embed and
    nothing to retrieve on, and a chunk of it would be an empty passage that
    dilutes the index. The figure is still in the artifact, still in storage and
    still locatable; it is simply not searchable, which is the honest state.

    Read from the same artifact JSON the elements are, so a `reindex` over a
    cached parse re-creates the figure chunks with no model call and no
    re-extraction — the same property that makes re-chunking a document free.
    """
    if not isinstance(contents, dict):
        return []
    images = contents.get("images")
    if not isinstance(images, list):
        return []

    last_on_page = _last_order_per_page(contents)
    elements: list[SourceElement] = []
    for index, raw in enumerate(images):
        if not isinstance(raw, dict):
            continue
        caption = str(raw.get("caption") or "").strip()
        if not caption:
            continue
        bbox = _bbox(raw.get("bbox"))
        page = raw.get("page")
        if bbox is None or not isinstance(page, int) or page < 1:
            continue

        text = FIGURE_CHUNK_TEMPLATE.format(caption=caption)
        elements.append(
            SourceElement(
                # A half step past the last element on the figure's page, so a
                # figure chunk lands between the page it is on and the page
                # after it rather than at the end of the document.
                order=last_on_page.get(page, -1.0) + 0.5,
                id=str(raw.get("id") or f"img_{index + 1:03d}"),
                type="figure",
                text=text,
                markdown=text,
                page=page,
                bbox=bbox,
                section_path=(),
            )
        )
    return elements


def _last_order_per_page(contents: dict[str, Any]) -> dict[int, float]:
    """The index of the last `contents` entry on each page."""
    positions: dict[int, float] = {}
    entries = contents.get("contents")
    if not isinstance(entries, list):
        return positions
    for index, raw in enumerate(entries):
        if isinstance(raw, dict) and isinstance(raw.get("page"), int):
            positions[raw["page"]] = float(index)
    return positions


def _bbox(value: Any) -> tuple[float, float, float, float] | None:
    """`[x0, y0, x1, y1]`, or `None` when the element is not locatable."""
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        x0, y0, x1, y1 = (float(part) for part in value)
    except (TypeError, ValueError):
        return None
    # Normalised rather than rejected: a parser that emitted a box backwards is
    # a bug worth fixing, but a highlight drawn from a backwards box is simply
    # invisible, and the ordering is part of the convention.
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
