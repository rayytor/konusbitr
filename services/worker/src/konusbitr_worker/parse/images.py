"""Pulling the figures out of a document, so that what a chart says is searchable.

A presentation, a research paper and an earnings report all put their most
quotable content in pictures. Until Phase 12.2 the pipeline saw a `picture`
element with whatever caption sat beneath it and nothing else: "which region
grew fastest in Q3?" could not be answered from a document whose only answer was
a bar chart, and the failure was silent — retrieval found the surrounding prose
and the model answered from that.

This module is the first half of fixing it. It extracts the raster objects a PDF
embeds, filters out everything that is not a figure, and hands the bytes to the
caller to store. The second half is
:mod:`konusbitr_worker.parse.captions`, which asks the vision role what each one
shows.

Three filters, and each removes a different kind of non-figure:

**Too small.** Under :data:`MIN_IMAGE_EDGE` pixels on either side is a bullet
glyph, a logo, a rule, or a signature squiggle. A hundred pixels is small enough
to keep a genuinely small inset chart and large enough to remove the furniture.

**Too large.** An image covering nearly the whole page *is* the page: it is the
scan, and captioning it would ask a vision model to describe a photograph of
text that the OCR tier has already read properly. The page-area ratio catches
the ones the tier filter below misses — a born-digital page with a full-bleed
cover image, for instance.

**On a recognised page.** A page in the `ocr` tier has exactly one image on it
and that image is the page. Skipping the tier outright is cheaper and more
certain than measuring, and the area filter stays as the backstop for the mixed
cases.

Duplicates are stored once. A letterhead or a footer mark appears as an image
object on every page of a document, and a corpus that stores four hundred copies
of the same logo has turned a filter miss into a storage bill. They are matched
on the bytes of the encoded PNG, which is exact.

PDFium again, for the reason `docs/coordinates.md` gives: it is the renderer
this pipeline already measures pages with, and it is Apache-2.0. PyMuPDF has a
nicer image API and is AGPL, which is the whole of why it is not here.
"""

from __future__ import annotations

import hashlib
import io
from collections.abc import Iterator
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.geometry import BBox, CoordOrigin, PageGeometry

__all__ = [
    "IMAGE_CONTENT_TYPE",
    "MAX_IMAGES_PER_DOCUMENT",
    "MAX_PAGE_AREA_RATIO",
    "MIN_IMAGE_EDGE",
    "ExtractedImage",
    "ImageCandidate",
    "extract_images",
    "image_key",
]

logger = get_logger("konusbitr.worker.parse.images")

IMAGE_CONTENT_TYPE = "image/png"

#: Shortest side, in pixels, an embedded image must have to be a figure.
#: The phase's own number: below 100 by 100 is decoration.
MIN_IMAGE_EDGE = 100

#: Fraction of the page an image may cover before it is read as the page itself
#: rather than as a figure on it.
#:
#: 0.9 rather than 1.0 because a scanner's output is drawn slightly inside the
#: media box more often than exactly onto it, and a full-bleed cover image is
#: still not a figure anybody wants captioned.
MAX_PAGE_AREA_RATIO = 0.9

#: A ceiling per document, so that one pathological file cannot fill a bucket.
#: A real figure-heavy document — a slide deck, a paper — runs to tens.
MAX_IMAGES_PER_DOCUMENT = 200

#: How large an extracted figure may be before it is downscaled, longest edge in
#: pixels. A vision model resamples to roughly this anyway, and storing a 40
#: megapixel scan of a photograph costs the bucket rather than the answer.
MAX_IMAGE_EDGE = 2048


def image_key(org_id: str, document_id: str, index: int) -> str:
    """Where an extracted figure lives.

    **This must agree character for character with `documentImageKey` in
    `packages/storage/src/keys.ts`.** The worker writes these keys and the web
    app reads them, across a seam with no shared code, so both sides assert the
    layout in their own tests rather than trusting it — the same arrangement,
    and for the same reason, as `thumbnail_key`.

    Not zero-padded, because `documentImageKey` is not: figures are addressed
    from the parse artifact by their `storageKey` rather than listed in order
    off the prefix, which is what the thumbnails' padding exists for.
    """
    return f"orgs/{org_id}/documents/{document_id}/images/{index}.png"


@dataclass(slots=True)
class ImageCandidate:
    """One figure's pixels and where it sits, before it has been stored."""

    page: int
    bbox: BBox
    width: int
    height: int
    #: PNG bytes, ready to upload.
    data: bytes

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.data).hexdigest()


@dataclass(slots=True)
class ExtractedImage:
    """A stored figure, as `parse_results.contents.images[]` records it.

    The shape is mirrored in TypeScript by `ExtractedImageSchema` in
    `packages/shared/src/parse-artifact.ts`. It does not cross the Redis seam —
    it reaches the product surface through a `jsonb` column — so neither half is
    generated from the other and `packages/shared/test/parse-artifact.test.ts`
    pins the literal JSON they agree on.
    """

    id: str
    page: int
    bbox: BBox
    width: int
    height: int
    storage_key: str
    #: The vision model's description, when `settings.llm` asked for one and a
    #: vision role is configured. `None` is the ordinary case and is not a
    #: failure — see :mod:`konusbitr_worker.parse.captions`.
    caption: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "page": self.page,
            "bbox": self.bbox.as_list(),
            "width": self.width,
            "height": self.height,
            "storageKey": self.storage_key,
            "caption": self.caption,
        }


def image_id(index: int) -> str:
    """`img_001`. Zero-padded so a lexical sort is an extraction-order sort."""
    return f"img_{index:03d}"


def extract_images(
    path: Path,
    *,
    geometries: dict[int, PageGeometry],
    skip_pages: set[int] | None = None,
    only_pages: set[int] | None = None,
    seen: set[str] | None = None,
    min_edge: int = MIN_IMAGE_EDGE,
    limit: int = MAX_IMAGES_PER_DOCUMENT,
) -> Iterator[ImageCandidate]:
    """Yield each figure of a PDF as PNG bytes, one decoded bitmap at a time.

    A generator for the reason `render_thumbnails` is one: a full-page 300 DPI
    raster is roughly 25MB decoded, and materialising every image in a slide
    deck before the first is uploaded makes peak memory a function of the
    document rather than of the page.

    `only_pages` narrows the walk to one page batch, and `seen` is the caller's
    own digest set carried across those batches. Both exist for the same
    reason: a 900-page document is read a batch at a time, and the
    deduplication that removes a letterhead repeated on every page has to span
    the whole document rather than restart every sixteen pages — otherwise the
    logo is stored fifty-six times, once per batch.

    Synchronous and CPU-bound — the caller runs it on a thread.
    """
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_raw

    skip = skip_pages or set()
    seen = seen if seen is not None else set()
    produced = 0

    document = pdfium.PdfDocument(str(path))
    try:
        for index in range(len(document)):
            page_no = index + 1
            if page_no in skip:
                continue
            if only_pages is not None and page_no not in only_pages:
                continue
            geometry = geometries.get(page_no)
            if geometry is None:  # pragma: no cover - the inspection produced these
                continue

            page = document[index]
            try:
                objects = list(page.get_objects(filter=(pdfium_raw.FPDF_PAGEOBJ_IMAGE,)))
            except Exception:
                # A page whose object tree cannot be walked is not a reason to
                # fail a document that otherwise parsed. The figures on it are
                # lost; everything else is not.
                logger.warning("could not enumerate images on a page", exc_info=True)
                objects = []
                page.close()
                continue

            try:
                for obj in objects:
                    if produced >= limit:
                        logger.warning(
                            "stopped extracting images at the per-document ceiling",
                            extra={"limit": limit},
                        )
                        return
                    candidate = _candidate(obj, page_no, geometry, min_edge=min_edge)
                    if candidate is None:
                        continue
                    digest = candidate.digest
                    if digest in seen:
                        # A letterhead, a footer mark, a watermark. Stored once.
                        continue
                    seen.add(digest)
                    produced += 1
                    yield candidate
            finally:
                page.close()
    finally:
        document.close()


def _candidate(
    obj: Any, page_no: int, geometry: PageGeometry, *, min_edge: int
) -> ImageCandidate | None:
    """One image object, filtered and encoded, or `None` if it is not a figure."""
    try:
        width, height = (int(value) for value in obj.get_px_size())
    except Exception:
        return None
    if width < min_edge or height < min_edge:
        return None

    try:
        bounds = obj.get_bounds()
    except Exception:
        return None

    # PDFium reports an object's bounds in **unrotated** page space with the
    # origin at the bottom left, which is the one case `PageGeometry.normalize`
    # was written for: `rotated=False` is what applies the page's `/Rotate`.
    # This is the opposite of the OCR tier, where the renderer had already
    # applied it — see `docs/coordinates.md`.
    bbox = geometry.normalize(
        (float(bounds[0]), float(bounds[1]), float(bounds[2]), float(bounds[3])),
        origin=CoordOrigin.bottom_left,
        rotated=False,
    )
    if bbox.is_degenerate:
        return None

    page_area = geometry.width * geometry.height
    if page_area > 0 and (bbox.width * bbox.height) / page_area >= MAX_PAGE_AREA_RATIO:
        return None

    data = _encode(obj)
    if data is None:
        return None
    return ImageCandidate(page=page_no, bbox=bbox, width=width, height=height, data=data)


def _encode(obj: Any) -> bytes | None:
    """The image object as PNG bytes, downscaled if it is enormous.

    `render=False` asks PDFium for the embedded bitmap itself rather than for a
    rasterisation of the object as placed, so what is stored is the resolution
    the document actually carries — which is what a vision model wants and what
    a reader zooming into a chart wants.

    PNG rather than WebP, unlike thumbnails, and for a reason: this is the
    format `documentImageKey` names and the format every vision provider accepts
    without a conversion step. A thumbnail is only ever looked at by a browser;
    a figure is also read by a model.
    """
    try:
        bitmap = obj.get_bitmap(render=False)
    except Exception:
        logger.debug("could not decode an embedded image", exc_info=True)
        return None

    try:
        image = bitmap.to_pil()
    except Exception:
        logger.debug("could not convert an embedded image", exc_info=True)
        return None
    finally:
        with suppress(Exception):  # pragma: no cover - already closed
            bitmap.close()

    try:
        longest = max(image.size)
        if longest > MAX_IMAGE_EDGE:
            from PIL import Image

            scale = MAX_IMAGE_EDGE / longest
            image = image.resize(
                (max(int(image.width * scale), 1), max(int(image.height * scale), 1)),
                resample=Image.LANCZOS,
            )
        if image.mode not in ("RGB", "RGBA", "L"):
            image = image.convert("RGB")

        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=True)
        return buffer.getvalue()
    finally:
        image.close()
