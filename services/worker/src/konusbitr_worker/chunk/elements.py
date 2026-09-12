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

__all__ = ["SourceElement", "elements_from_contents"]

#: Element types, matching `ElementType` in the parse artifact. Anything
#: unrecognised is read as `paragraph`, which is the reading every consumer
#: already handles correctly.
_KNOWN_TYPES = frozenset({"heading", "paragraph", "table", "list", "figure", "caption", "footnote"})


@dataclass(frozen=True, slots=True)
class SourceElement:
    """One located element of a document, in reading order."""

    #: Position in the artifact's `contents`, so that chunks built out of
    #: separate streams — prose and tables are chunked apart — can be put back
    #: into reading order before their ordinals are assigned.
    order: int
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
                order=index,
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
