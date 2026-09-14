"""Rendering a PDF page to a bitmap the OCR engines can read.

PDFium again, for the same reason :mod:`konusbitr_worker.parse.thumbnails` uses
it: it renders the page **as a reader sees it**, with `/Rotate` already applied.
That single property is what keeps the coordinate story short. A word box comes
back in pixels of this bitmap, and turning it into the Konusbitr convention is a
multiply by ``72 / dpi`` — no rotation table, no origin flip, no per-document
flag. See `docs/coordinates.md`.

The DPI matters more than it looks. PP-OCRv4 and Tesseract are both trained on
text around 30-40 pixels tall; a 10pt line rendered at 150 DPI is 20 pixels and
recognition falls off a cliff, while 600 DPI quadruples the pixels for no
accuracy at all. 300 is the settled answer for both engines, which is why it is
the default and why anything below it is upscaled rather than fed in as-is.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover - typing only
    pass

__all__ = ["POINTS_PER_INCH", "RasterPage", "render_page", "render_pages"]

POINTS_PER_INCH = 72.0


@dataclass(slots=True)
class RasterPage:
    """One page as pixels, plus everything needed to get back to points.

    `dpi` is the *effective* resolution actually rendered at, which can differ
    from the requested one: PDFium is asked for a scale factor rather than a
    DPI, and a page whose bitmap would exceed `max_pixels` is rendered smaller.
    Storing what was rendered rather than what was asked for is the difference
    between a bbox that lands on the word and one that lands near it.
    """

    page_no: int
    image: Any
    dpi: float
    #: The visible page size in points, which every converted box is clamped to.
    width_points: float
    height_points: float

    @property
    def scale(self) -> float:
        """Points per pixel: what a pixel coordinate is multiplied by."""
        return POINTS_PER_INCH / self.dpi


#: A ceiling on one rendered page, in pixels.
#:
#: A 300 DPI Letter page is about 8.4 megapixels and an A0 poster at the same
#: DPI is 140 — enough to make a worker with two gigabytes of memory die on one
#: page of one document. Oversized pages are rendered at whatever DPI fits and
#: the real DPI is recorded, so the coordinates stay right even where the
#: recognition gets harder.
MAX_RASTER_PIXELS = 40_000_000


def render_pages(
    path: Path,
    pages: list[int],
    *,
    dpi: float,
    max_pixels: int = MAX_RASTER_PIXELS,
) -> Iterator[RasterPage]:
    """Yield one :class:`RasterPage` per requested page, one bitmap at a time.

    A generator for the reason `render_thumbnails` is one: a 300 DPI page is
    roughly 25MB decoded, and materialising a hundred of them before the first
    is recognised makes peak memory a function of page count.

    Synchronous and CPU-bound — callers run it on a thread.
    """
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(str(path))
    try:
        for page_no in pages:
            rendered = _render(document, page_no, dpi=dpi, max_pixels=max_pixels)
            if rendered is not None:
                yield rendered
    finally:
        document.close()


def render_page(
    path: Path,
    page_no: int,
    *,
    dpi: float,
    max_pixels: int = MAX_RASTER_PIXELS,
) -> RasterPage | None:
    """One page, for the tests and for a single-page retry."""
    for rendered in render_pages(path, [page_no], dpi=dpi, max_pixels=max_pixels):
        return rendered
    return None


def _render(document: Any, page_no: int, *, dpi: float, max_pixels: int) -> RasterPage | None:
    import numpy as np

    page = document[page_no - 1]
    try:
        # Already rotated: PDFium applies `/Rotate` to both the reported size
        # and the render, so the bitmap and the stored page row describe the
        # same picture.
        width_points = float(page.get_width())
        height_points = float(page.get_height())
        if width_points <= 0 or height_points <= 0:  # pragma: no cover - malformed page
            return None

        scale = dpi / POINTS_PER_INCH
        pixels = (width_points * scale) * (height_points * scale)
        if pixels > max_pixels:
            scale *= (max_pixels / pixels) ** 0.5

        bitmap = page.render(scale=scale)
        try:
            image = np.asarray(bitmap.to_pil().convert("RGB"))
        finally:
            bitmap.close()
    finally:
        page.close()

    return RasterPage(
        page_no=page_no,
        image=image,
        dpi=scale * POINTS_PER_INCH,
        width_points=width_points,
        height_points=height_points,
    )
