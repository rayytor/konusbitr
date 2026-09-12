"""What can be learned about a PDF before deciding to parse it.

Three questions, answered in one pass over the file with PDFium, before Docling
is asked to do anything expensive:

**Is it a PDF at all, and can it be opened?** A truncated upload, a shredded
cross-reference table or a file that is a PDF only by extension all fail here,
terminally, with a message that names the problem.

**Is it encrypted?** A password-protected document is not corrupt and telling
somebody it is would send them looking for the wrong fix.

**Does it have a text layer worth parsing?** This is the one that matters most,
because it is the only failure mode that can produce a *plausible* wrong answer.
A scanned page has no extractable characters; a standard-tier parse of it
yields an empty document, or worse, the handful of characters in a header — and
a chat built on that will answer questions confidently out of nothing. So the
document is refused with `needs_ocr` and a message that says where OCR is
coming from, rather than parsed into silence.

PDFium rather than Docling for all of it: these are cheap structural questions,
and asking them before loading a layout model is the difference between
rejecting a bad file in milliseconds and rejecting it in seconds.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from konusbitr_worker.contracts import JobErrorCode
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.geometry import PageGeometry, normalize_rotation

__all__ = ["DocumentInspection", "inspect_pdf"]

logger = get_logger("konusbitr.worker.parse.inspect")

#: Character density, per square inch of page, at which a page is unambiguously
#: born-digital and coverage saturates at 1.0.
#:
#: Deliberately low. The question this score answers is **"does this page have a
#: text layer?"**, not "how much of this page is prose" — and those want very
#: different scales. Real documents are full of pages that are legitimately
#: sparse: a title page, a chapter opener, a full-page chart with one caption.
#: Scoring those against the density of a dense body-text page (which runs to
#: 60-70 characters per square inch) would put them below any useful threshold
#: and refuse documents that parse perfectly well.
#:
#: Two characters per square inch is roughly one line of text on a Letter page.
#: A scan scores exactly 0.0, and anything with a real text layer clears the
#: default threshold several times over — which is what makes that threshold a
#: wide, uncontroversial gap rather than a tuning knob.
CHARS_PER_SQUARE_INCH_AT_FULL_COVERAGE = 2.0

#: A page below this fraction of that density is treated as imaged. At the
#: default it works out to about eighteen extractable characters on an A4 page.
#: Overridden by `TEXT_COVERAGE_THRESHOLD`; this is the default the Zod schema
#: and pydantic settings both carry.
DEFAULT_COVERAGE_THRESHOLD = 0.1

#: How much of a document may be imaged before the whole document is refused.
#: A fifth: a scanned signature page or a full-page chart inside an otherwise
#: born-digital report is normal and must not fail the upload.
MAX_IMAGED_PAGE_FRACTION = 0.2

_POINTS_PER_INCH = 72.0


@dataclass(frozen=True, slots=True)
class DocumentInspection:
    """Everything the structural pass learned, for the stages after it."""

    page_count: int
    pages: list[PageGeometry]
    #: Extractable-character coverage per page, index-aligned with `pages`.
    coverage: list[float]

    def imaged_pages(self, threshold: float) -> list[int]:
        """1-based page numbers whose coverage fell below `threshold`."""
        return [
            page.page_no
            for page, score in zip(self.pages, self.coverage, strict=True)
            if score < threshold
        ]


def inspect_pdf(
    path: Path,
    *,
    coverage_threshold: float = DEFAULT_COVERAGE_THRESHOLD,
    max_pages: int = 0,
) -> DocumentInspection:
    """Open, validate and measure a PDF. Raises :class:`JobFailure` on anything unusable.

    Runs synchronously and is CPU-bound; the pipeline calls it on a thread.
    """
    import pypdfium2 as pdfium

    try:
        document = pdfium.PdfDocument(str(path))
    except pdfium.PdfiumError as error:
        raise _open_failure(error) from error
    except Exception as error:  # A file that is not a PDF at all.
        raise JobFailure(
            JobErrorCode.corrupt_document,
            "That file could not be read as a PDF.",
        ) from error

    try:
        page_count = len(document)
        if page_count == 0:
            raise JobFailure(
                JobErrorCode.corrupt_document,
                "That PDF has no pages.",
            )
        if max_pages and page_count > max_pages:
            raise JobFailure(
                JobErrorCode.too_many_pages,
                f"That document has {page_count} pages; this instance allows {max_pages}.",
            )

        geometries: list[PageGeometry] = []
        coverage: list[float] = []
        for index in range(page_count):
            geometry, score = _measure_page(document, index)
            geometries.append(geometry)
            coverage.append(score)
    finally:
        document.close()

    inspection = DocumentInspection(page_count=page_count, pages=geometries, coverage=coverage)
    _require_text_layer(inspection, coverage_threshold)
    return inspection


def _open_failure(error: Exception) -> JobFailure:
    """Distinguish "needs a password" from "is broken".

    They are both terminal and the retry policy treats them identically, so the
    only thing that turns on the difference is what the person who uploaded the
    file is told — which is the whole point. "That file is corrupt" sent to
    somebody holding a perfectly good encrypted PDF wastes their afternoon.
    """
    message = str(error).lower()
    if "password" in message or "encrypt" in message:
        return JobFailure(
            JobErrorCode.encrypted_document,
            "That PDF is password-protected. Remove the password and upload it again.",
        )
    return JobFailure(
        JobErrorCode.corrupt_document,
        "That PDF is damaged and could not be opened.",
    )


def _measure_page(document: object, index: int) -> tuple[PageGeometry, float]:
    """One page's geometry and its extractable-character density."""
    page = document[index]  # type: ignore[index]
    try:
        # PDFium's page width and height are the page **as displayed**: it has
        # already applied `/Rotate`. `PageGeometry` wants the page as stored,
        # because it is the thing that applies the rotation — so a quarter turn
        # is un-swapped back here rather than being applied twice.
        visible_width = float(page.get_width())
        visible_height = float(page.get_height())
        rotation = normalize_rotation(page.get_rotation())

        textpage = page.get_textpage()
        try:
            characters = textpage.count_chars()
        finally:
            textpage.close()
    finally:
        page.close()

    quarter_turned = rotation in (90, 270)
    geometry = PageGeometry(
        page_no=index + 1,
        raw_width=visible_height if quarter_turned else visible_width,
        raw_height=visible_width if quarter_turned else visible_height,
        rotation=rotation,
    )
    return geometry, _coverage(characters, visible_width, visible_height)


def _coverage(characters: int, width: float, height: float) -> float:
    """Extractable-character density.

    Computed as a fraction of :data:`CHARS_PER_SQUARE_INCH_AT_FULL_COVERAGE`.
    Normalized by *area* rather than compared to a flat count, so an A6 page of
    dense text is not mistaken for a scan and a poster-sized page carrying one
    paragraph is not credited with being prose.
    """
    area_square_inches = (width / _POINTS_PER_INCH) * (height / _POINTS_PER_INCH)
    if area_square_inches <= 0:
        return 0.0
    expected = area_square_inches * CHARS_PER_SQUARE_INCH_AT_FULL_COVERAGE
    return min(characters / expected, 1.0)


def _require_text_layer(inspection: DocumentInspection, threshold: float) -> None:
    """Refuse a document the standard tier cannot read honestly."""
    imaged = inspection.imaged_pages(threshold)
    if not imaged:
        return

    fraction = len(imaged) / inspection.page_count
    logger.info(
        "text-layer coverage measured",
        extra={
            "pages": inspection.page_count,
            "imaged_pages": len(imaged),
            "threshold": threshold,
        },
    )
    if fraction <= MAX_IMAGED_PAGE_FRACTION:
        return

    raise JobFailure(
        JobErrorCode.needs_ocr,
        "That document has little or no selectable text — it looks like a scan. "
        "Text recognition arrives with the advanced pipeline; until then, upload "
        "a PDF with a text layer.",
    )
