"""The one coordinate convention, and the only place anything is converted into it.

PDF user-space points, origin **top-left**, y increasing downward, on the
**unrotated** page. `docs/coordinates.md` is the specification; this module is
the implementation, and it is deliberately the whole of it. Nothing downstream
of the parse artifact converts anything — the Phase 11 viewer applies a scale
factor and no more — so a box that leaves here wrong is wrong everywhere, and a
box that leaves here right needs no flags to interpret.

Everything below is pure arithmetic on floats. That is not an accident: it is
what lets the convention be tested against hand-computed expectations rather
than against whatever the parser happened to emit.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

__all__ = ["BBox", "CoordOrigin", "PageGeometry", "normalize_rotation"]


class CoordOrigin(StrEnum):
    """Where a source's y axis starts. Docling emits both; PDF itself is bottom-left."""

    top_left = "top_left"
    bottom_left = "bottom_left"


@dataclass(frozen=True, slots=True)
class BBox:
    """A box in the Konusbitr convention: points, top-left origin, y downward."""

    x0: float
    y0: float
    x1: float
    y1: float

    def as_list(self) -> list[float]:
        """The wire form — four rounded floats, in the order the artifact stores."""
        return [round(value, 2) for value in (self.x0, self.y0, self.x1, self.y1)]

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    def clamp(self, width: float, height: float) -> BBox:
        """Pull a box back inside its page.

        Parsers overshoot by fractions of a point on glyphs that extend past
        their own advance width, and a box that runs off the page draws a
        highlight that runs off the page. Clamping is honest here in a way it
        would not be on a whole-page overshoot — which is a bug in the
        conversion, and is what the geometry tests exist to catch.
        """
        return BBox(
            x0=min(max(self.x0, 0.0), width),
            y0=min(max(self.y0, 0.0), height),
            x1=min(max(self.x1, 0.0), width),
            y1=min(max(self.y1, 0.0), height),
        )

    @property
    def is_degenerate(self) -> bool:
        """True when the box encloses nothing and so cannot be highlighted."""
        return self.width <= 0.0 or self.height <= 0.0


def normalize_rotation(rotation: int | float | None) -> int:
    """Reduce a PDF `/Rotate` to one of 0, 90, 180, 270.

    PDFs in the wild carry negative values, multiples beyond 360, and values
    that are not multiples of 90 at all. The first two have an obvious meaning
    and are honoured; the third does not, and is rounded to the nearest quarter
    turn rather than raising — a page with `/Rotate 47` is malformed, but
    refusing to parse the whole document over it would serve nobody.
    """
    if rotation is None:
        return 0
    quarter = round(float(rotation) / 90.0) % 4
    return quarter * 90


@dataclass(frozen=True, slots=True)
class PageGeometry:
    """One page's size and rotation, and the conversion that depends on both.

    `raw_width`/`raw_height` are the page as the PDF stores it; `width`/`height`
    are the page as a reader sees it, which is the pair written to the `pages`
    row and the pair every stored bbox is measured against.
    """

    page_no: int
    raw_width: float
    raw_height: float
    rotation: int = 0

    def __post_init__(self) -> None:
        object.__setattr__(self, "rotation", normalize_rotation(self.rotation))

    @property
    def quarter_turned(self) -> bool:
        return self.rotation in (90, 270)

    @property
    def width(self) -> float:
        """Visible width: the raw dimensions swap on a quarter turn."""
        return self.raw_height if self.quarter_turned else self.raw_width

    @property
    def height(self) -> float:
        return self.raw_width if self.quarter_turned else self.raw_height

    def normalize(
        self,
        box: tuple[float, float, float, float],
        *,
        origin: CoordOrigin,
        rotated: bool = False,
    ) -> BBox:
        """Convert one source box into the Konusbitr convention.

        `origin` says which way the source's y axis pointed. `rotated` says
        whether the source had *already* applied the page rotation — Docling's
        backends normalize some documents and not others, and applying the
        rotation twice is the failure this flag exists to prevent. A caller that
        does not know must find out rather than guess: a 90° error is invisible
        on a square figure and glaring on a line of text.
        """
        left, top, right, bottom = box

        if origin is CoordOrigin.bottom_left:
            # y grows upward in the source, so the larger y is the visual top.
            source_height = self.height if rotated else self.raw_height
            y0 = source_height - max(top, bottom)
            y1 = source_height - min(top, bottom)
        else:
            y0, y1 = min(top, bottom), max(top, bottom)

        x0, x1 = min(left, right), max(left, right)

        if rotated:
            # Already in the visible frame; only the clamp is left to do.
            return BBox(x0, y0, x1, y1).clamp(self.width, self.height)

        return self._rotate(BBox(x0, y0, x1, y1)).clamp(self.width, self.height)

    def _rotate(self, box: BBox) -> BBox:
        """Map an unrotated-frame box into the visible frame.

        The table in `docs/coordinates.md` and this method are the same four
        cases; keep them in step.
        """
        if self.rotation == 0:
            return box
        if self.rotation == 90:
            return BBox(
                x0=self.raw_height - box.y1,
                y0=box.x0,
                x1=self.raw_height - box.y0,
                y1=box.x1,
            )
        if self.rotation == 180:
            return BBox(
                x0=self.raw_width - box.x1,
                y0=self.raw_height - box.y1,
                x1=self.raw_width - box.x0,
                y1=self.raw_height - box.y0,
            )
        return BBox(
            x0=box.y0,
            y0=self.raw_width - box.x1,
            x1=box.y1,
            y1=self.raw_width - box.x0,
        )
