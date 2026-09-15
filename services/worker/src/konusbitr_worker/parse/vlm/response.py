"""Turning what a vision model said into elements this pipeline can use.

The prompt asks for one JSON object with an `elements` array. What comes back
is a *language model's* attempt at that, so every rule below exists because
some provider, on some page, does the thing it guards against:

- fences the JSON in ```json,
- prefixes it with "Here is the structured transcription:",
- returns `bbox` instead of `bbox_normalized`, or `[xmin, ymin, xmax, ymax]`
  instead of the specified `[ymin, xmin, ymax, xmax]`,
- returns a box on a 0-1 scale rather than 0-1000,
- gives a `level` of `"2"` rather than `2`,
- omits `reading_order` entirely.

None of those is worth failing a page over and none may be papered over
silently either, so this module is deliberately lenient about *shape* and
completely strict about *geometry*: an element whose box cannot be resolved to a
rectangle on the page is dropped, because an element that cannot be pointed at
cannot be cited, and an uncitable answer is the failure this product exists to
prevent.

The reordering axis question — `[ymin, xmin, ymax, xmax]` — is settled by the
prompt and then checked: a box whose first pair exceeds the page in the y axis
but fits in the x axis was written the other way round, and is transposed rather
than discarded. See :func:`_rectangle`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.artifact import ElementType, TableData
from konusbitr_worker.parse.geometry import BBox, CoordOrigin, PageGeometry

__all__ = [
    "NORMALIZED_SCALE",
    "VlmElement",
    "parse_response",
]

logger = get_logger("konusbitr.worker.parse.vlm.response")

#: The coordinate scale the prompt specifies: 0-1000 on each axis.
NORMALIZED_SCALE = 1000.0

#: The label vocabulary the prompt offers, mapped onto the artifact's seven
#: types. `callout` is in the prompt because pull quotes and warning boxes are
#: real page furniture a model should be able to name rather than mislabel; the
#: artifact has no such type, and a callout reads correctly as a paragraph.
_TYPES: dict[str, ElementType] = {
    "heading": ElementType.heading,
    "title": ElementType.heading,
    "paragraph": ElementType.paragraph,
    "text": ElementType.paragraph,
    "callout": ElementType.paragraph,
    "quote": ElementType.paragraph,
    "table": ElementType.table,
    "list": ElementType.list,
    "list_item": ElementType.list,
    "figure": ElementType.figure,
    "image": ElementType.figure,
    "chart": ElementType.figure,
    "caption": ElementType.caption,
    "footnote": ElementType.footnote,
}

#: Keys a model has been seen to use for the box, in the order they are tried.
_BBOX_KEYS = ("bbox_normalized", "bbox", "box", "bounding_box", "bbox_2d")

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)


@dataclass(slots=True)
class VlmElement:
    """One block the model reported, located in the Konusbitr convention."""

    type: ElementType
    text: str
    markdown: str
    bbox: BBox
    reading_order: int
    level: int | None = None
    table: TableData | None = None
    #: Filled in by reconciliation. `False` means no text layer backed this
    #: block's characters, so what it says is the model's word alone.
    grounded: bool = False
    #: Diagnostic counts from reconciliation; see `reconcile.py`.
    reconciliation: dict[str, int] = field(default_factory=dict)


def parse_response(raw: str, geometry: PageGeometry) -> list[VlmElement]:
    """Parse one page's answer into elements, in the model's reading order.

    Returns `[]` for an answer that is not JSON at all or that carries no usable
    element. An empty page is a legitimate answer — the prompt says so — and the
    caller distinguishes "the model found nothing" from "the model failed" by
    the exception it did or did not see, not by this list's length.
    """
    payload = _decode(raw)
    if payload is None:
        return []

    items = payload.get("elements")
    if not isinstance(items, list):
        return []

    elements: list[VlmElement] = []
    for position, item in enumerate(items):
        element = _element(item, geometry, fallback_order=position + 1)
        if element is not None:
            elements.append(element)

    # The model's own `reading_order` decides, with its array position as the
    # tiebreak. That field is the entire reason this tier exists — a multi-column
    # page's correct sequence is the thing a coordinate sort cannot recover —
    # so it is honoured even where it disagrees with the array.
    elements.sort(key=lambda element: element.reading_order)
    return elements


def _decode(raw: str) -> dict[str, Any] | None:
    """The JSON object in an answer, however the model chose to wrap it."""
    text = (raw or "").strip()
    if not text:
        return None

    fenced = _FENCE.match(text)
    if fenced:
        text = fenced.group(1).strip()

    for candidate in (text, _outermost_object(text)):
        if not candidate:
            continue
        try:
            payload = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(payload, dict):
            return payload
        if isinstance(payload, list):
            # A model that skipped the envelope and returned the array itself.
            return {"elements": payload}

    logger.warning("the vision model did not return parseable JSON for a page")
    return None


def _outermost_object(text: str) -> str | None:
    """The substring from the first `{` to the last `}`, for a prefixed answer."""
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        return None
    return text[start : end + 1]


def _element(item: Any, geometry: PageGeometry, *, fallback_order: int) -> VlmElement | None:
    if not isinstance(item, dict):
        return None

    element_type = _TYPES.get(str(item.get("type") or "").strip().lower(), ElementType.paragraph)
    bbox = _rectangle(item, geometry)
    if bbox is None:
        logger.debug("dropping a VLM element with no usable box")
        return None

    level = _level(item) if element_type is ElementType.heading else None
    table = _table(item) if element_type is ElementType.table else None

    text = _string(item.get("text"))
    markdown = _string(item.get("markdown"))

    if element_type is ElementType.table:
        from konusbitr_worker.parse.artifact import markdown_table

        if table is not None:
            rendered = markdown_table(table.headers, table.rows)
            if rendered:
                markdown = rendered
        # A table's text is its markdown: the cells are the content, and a
        # concatenation with the row structure discarded embeds into something
        # that retrieves for every number on the page. Same rule as both other
        # tiers.
        text = markdown or text
        markdown = markdown or text

    if element_type is ElementType.heading and level is not None:
        markdown = f"{'#' * level} {text}".rstrip() if text else markdown
    elif element_type is ElementType.list:
        markdown = markdown or (f"- {text}" if text else "")
    elif element_type is ElementType.figure:
        markdown = markdown or (f"![{text}]()" if text else "![]()")
    else:
        markdown = markdown or text

    if not text.strip() and element_type is not ElementType.figure:
        return None

    return VlmElement(
        type=element_type,
        text=text,
        markdown=markdown,
        bbox=bbox,
        reading_order=_reading_order(item, fallback_order),
        level=level,
        table=table,
    )


def _string(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return " ".join(_string(entry) for entry in value).strip()
    return str(value).strip()


def _reading_order(item: dict[str, Any], fallback: int) -> int:
    for key in ("reading_order", "readingOrder", "order", "index"):
        try:
            return int(item[key])
        except (KeyError, TypeError, ValueError):
            continue
    return fallback


def _level(item: dict[str, Any]) -> int:
    try:
        return max(1, min(int(item.get("level", 2)), 6))
    except (TypeError, ValueError):
        return 2


def _table(item: dict[str, Any]) -> TableData | None:
    """The table's grid, when the model returned one.

    No cell boxes. A vision model asked for a rectangle per cell returns a
    plausible grid of rectangles that drift by several points each, and a
    citation that lands one row off a financial table is worse than one that
    highlights the whole table honestly. `TableData.cells` being empty is a
    supported state and says exactly that — `headers` and `rows` are the
    contract, and Phase 13's `extract` addresses them without needing geometry.
    """
    headers = [_string(cell) for cell in item.get("headers") or [] if not isinstance(cell, dict)]
    raw_rows = item.get("rows") or []
    if not isinstance(raw_rows, list):
        return None

    rows: list[list[str]] = []
    for row in raw_rows:
        if isinstance(row, list):
            rows.append([_string(cell) for cell in row])
        elif isinstance(row, dict):
            # Some models answer with a row of `{"column": "value"}`, which is
            # a grid only if every row names the same columns. Values in key
            # order is the reading that survives the ones that do not.
            rows.append([_string(value) for value in row.values()])

    if not headers and not rows:
        return None

    width = max([len(headers), *(len(row) for row in rows)])
    if width == 0:
        return None

    # Ragged rows are the common failure: a model drops an empty trailing cell.
    # Padding keeps `markdown_table` and `TableData.num_cols` agreeing, and an
    # empty string is the honest value for a cell the model did not report.
    padded = [[*row, *([""] * (width - len(row)))] for row in rows]
    return TableData(headers=headers, rows=padded, cells=[])


def _rectangle(item: dict[str, Any], geometry: PageGeometry) -> BBox | None:
    """One element's box, on the page, in points.

    Three corrections, applied in this order and each of them load-bearing:

    **Scale.** The prompt says 0-1000. Some models answer on 0-1 anyway. A box
    whose every value is at most 1 and which is not degenerate on the 0-1000
    scale is read as a fraction — the alternative reading makes it a rectangle
    one thousandth of the page across, which is never a real element.

    **Axis order.** The prompt says ``[ymin, xmin, ymax, xmax]``, which is what
    Gemini and Qwen emit natively and the opposite of what a model trained on
    ``[x0, y0, x1, y1]`` emits. Read in the specified order first; transpose
    only when the specified reading is degenerate and the transposed one is not.

    **Frame.** The box is a fraction of the page image, and the page image is
    the page a reader sees — PDFium applied ``/Rotate`` when it rendered it. So
    the conversion is ``origin=top_left, rotated=True``: exactly the OCR tier's
    call, for exactly the OCR tier's reason, and the opposite of
    ``parse/images.py``. See `docs/coordinates.md`.
    """
    values = _numbers(item)
    if values is None:
        return None

    scale = NORMALIZED_SCALE
    if all(abs(value) <= 1.0 for value in values):
        scale = 1.0

    width, height = geometry.width, geometry.height

    def points(ymin: float, xmin: float, ymax: float, xmax: float) -> BBox:
        return BBox(
            x0=min(xmin, xmax) / scale * width,
            y0=min(ymin, ymax) / scale * height,
            x1=max(xmin, xmax) / scale * width,
            y1=max(ymin, ymax) / scale * height,
        )

    specified = points(values[0], values[1], values[2], values[3])
    if not specified.is_degenerate:
        return geometry.normalize(
            (specified.x0, specified.y0, specified.x1, specified.y1),
            origin=CoordOrigin.top_left,
            rotated=True,
        )

    transposed = points(values[1], values[0], values[3], values[2])
    if transposed.is_degenerate:
        return None
    return geometry.normalize(
        (transposed.x0, transposed.y0, transposed.x1, transposed.y1),
        origin=CoordOrigin.top_left,
        rotated=True,
    )


def _numbers(item: dict[str, Any]) -> tuple[float, float, float, float] | None:
    for key in _BBOX_KEYS:
        raw = item.get(key)
        if isinstance(raw, dict):
            raw = [raw.get(name) for name in ("ymin", "xmin", "ymax", "xmax")]
        if not isinstance(raw, (list, tuple)) or len(raw) != 4:
            continue
        try:
            return tuple(float(value) for value in raw)  # type: ignore[return-value]
        except (TypeError, ValueError):
            continue
    return None
