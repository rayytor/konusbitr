"""Page thumbnails: one WebP per page, longest edge 1600px.

The library grid and the Phase 11 page rail both need a picture of a page long
before anybody wants the page itself, and rendering one in the browser means
shipping a PDF renderer and the whole document to do it. Rendering them once,
here, costs a few hundred milliseconds per document and nothing afterwards.

WebP because it is half the bytes of a JPEG at the same quality for this kind
of content — mostly white, sharp black text, where JPEG's ringing is at its
worst — and universally supported by every browser this product targets.

Rendered from the **rotated** page, so a thumbnail and the coordinates in
`docs/coordinates.md` describe the same picture. A thumbnail that disagreed
with the bboxes would put a highlight in the right place on a page the user is
looking at sideways.
"""

from __future__ import annotations

import io
from collections.abc import Iterator
from pathlib import Path

from konusbitr_worker.log import get_logger

__all__ = ["THUMBNAIL_CONTENT_TYPE", "render_thumbnails", "thumbnail_key"]

logger = get_logger("konusbitr.worker.parse.thumbnails")

THUMBNAIL_CONTENT_TYPE = "image/webp"

#: Encoder quality. 82 is the knee of the curve for text-on-white: visibly
#: identical to 95 at roughly half the bytes.
_WEBP_QUALITY = 82

_POINTS_PER_INCH = 72.0


def thumbnail_key(org_id: str, document_id: str, page_no: int) -> str:
    """Where a page's thumbnail lives.

    The same layout as the original object, one level deeper. Every segment is
    a generated id or an integer — nothing here is ever built from a filename
    or anything else a user chose.

    Zero-padded to five digits so that a lexical listing of the prefix is a
    page-order listing: `00002` sorts before `00010`, where `2` sorts after
    `10`. The viewer's page rail pages through the prefix rather than asking
    for each key, so the order is load-bearing.

    **This must agree character for character with `pageThumbnailKey` in
    `packages/storage/src/keys.ts`.** The worker writes these keys and the web
    app reads them, across a seam with no shared code, so both sides assert the
    layout in their own tests rather than trusting it. They disagreed once.
    """
    return f"orgs/{org_id}/documents/{document_id}/thumbnails/{page_no:05d}.webp"


def render_thumbnails(
    path: Path,
    *,
    max_edge: int,
    pages: list[int] | None = None,
) -> Iterator[tuple[int, bytes]]:
    """Yield `(page_no, webp_bytes)` for each page, one page in memory at a time.

    A generator rather than a list: a 500-page document is 500 decoded bitmaps,
    and materialising them all before uploading the first would make the
    memory ceiling a function of page count. The caller uploads as it goes.

    Synchronous and CPU-bound — the pipeline runs it on a thread.
    """
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(str(path))
    try:
        wanted = pages if pages is not None else range(1, len(document) + 1)
        for page_no in wanted:
            page = document[page_no - 1]
            try:
                # `get_width`/`get_height` already account for `/Rotate`, and
                # PDFium renders the rotated page, so the thumbnail matches the
                # frame the stored bboxes are in without any further work.
                longest_point_edge = max(page.get_width(), page.get_height())
                if longest_point_edge <= 0:  # pragma: no cover - malformed page
                    continue
                scale = max_edge / longest_point_edge
                bitmap = page.render(scale=scale)
                try:
                    image = bitmap.to_pil().convert("RGB")
                finally:
                    bitmap.close()
            finally:
                page.close()

            buffer = io.BytesIO()
            image.save(buffer, format="WEBP", quality=_WEBP_QUALITY, method=4)
            image.close()
            yield page_no, buffer.getvalue()
    finally:
        document.close()


def render_dpi(max_edge: int, longest_point_edge: float) -> float:
    """The effective DPI a thumbnail is rendered at. Diagnostic only."""
    if longest_point_edge <= 0:
        return 0.0
    return max_edge / (longest_point_edge / _POINTS_PER_INCH)
