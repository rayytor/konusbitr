"""What can be learned about a PDF before deciding to parse it.

Three questions, answered in one pass over the file with PDFium, before Docling
is asked to do anything expensive:

**Is it a PDF at all, and can it be opened?** A truncated upload, a shredded
cross-reference table or a file that is a PDF only by extension all fail here,
terminally, with a message that names the problem.

**Is it encrypted?** A password-protected document is not corrupt and telling
somebody it is would send them looking for the wrong fix.

**Which pages have a text layer worth parsing?** This is the one that matters
most, because it is the only failure mode that can produce a *plausible* wrong
answer. A scanned page has no extractable characters; a standard-tier parse of
it yields an empty page, or worse, the handful of characters in a header — and
a chat built on that will answer questions confidently out of nothing.

Phase 07 asked that question of the whole document and refused the whole
document. Phase 12.1 asks it **per page**, which is the same measurement read at
the right granularity: every page gets a :class:`PageTier`, and a hundred-page
filing with three scanned exhibits sends three pages to the recogniser rather
than all hundred or none of them. The document-level refusal survives as the
behaviour when no recogniser is configured — `needs_ocr` is still the honest
answer when there is nothing that can read the page.

PDFium rather than Docling for all of it: these are cheap structural questions,
and asking them before loading a layout model is the difference between
rejecting a bad file in milliseconds and rejecting it in seconds.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from konusbitr_worker.contracts import JobErrorCode
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.artifact import PageTier
from konusbitr_worker.parse.geometry import PageGeometry, normalize_rotation

__all__ = [
    "DocumentInspection",
    "classify_page_tier",
    "inspect_pdf",
    "require_text_layer",
]

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


def classify_page_tier(coverage: float, *, threshold: float) -> PageTier:
    """Which tier one page belongs to, from its extractable-text density.

    The whole of the classification, and deliberately one line: the measurement
    is :func:`_coverage`, the policy is this comparison, and keeping them apart
    is what lets the threshold be tuned without anyone re-deriving what it is
    measuring.

    Returns :attr:`PageTier.native` for a page with a real font/text layer and
    :attr:`PageTier.ocr` for a raster scan, an image-only page, or a page whose
    text layer is too thin to be the page's content — the last being the case
    that a binary "has any text at all" test gets wrong, because a scan under a
    running header has text on it and is still a scan.
    """
    return PageTier.native if coverage >= threshold else PageTier.ocr


@dataclass(frozen=True, slots=True)
class DocumentInspection:
    """Everything the structural pass learned, for the stages after it."""

    page_count: int
    pages: list[PageGeometry]
    #: Extractable-character coverage per page, index-aligned with `pages`.
    coverage: list[float]
    #: Each page's tier, index-aligned with `pages`.
    tiers: list[PageTier] = field(default_factory=list)

    def imaged_pages(self, threshold: float) -> list[int]:
        """1-based page numbers whose coverage fell below `threshold`."""
        return [
            page.page_no
            for page, score in zip(self.pages, self.coverage, strict=True)
            if score < threshold
        ]

    def pages_in_tier(self, tier: PageTier) -> list[int]:
        """1-based page numbers classified into `tier`."""
        return [
            page.page_no
            for page, page_tier in zip(self.pages, self.tiers, strict=True)
            if page_tier is tier
        ]

    def tier_of(self, page_no: int) -> PageTier:
        """One page's tier, defaulting to native for a page number we never saw."""
        for page, tier in zip(self.pages, self.tiers, strict=True):
            if page.page_no == page_no:
                return tier
        return PageTier.native


def inspect_pdf(
    path: Path,
    *,
    coverage_threshold: float = DEFAULT_COVERAGE_THRESHOLD,
    max_pages: int = 0,
    ocr_available: bool = False,
) -> DocumentInspection:
    """Open, validate and measure a PDF. Raises :class:`JobFailure` on anything unusable.

    `ocr_available` says whether a recogniser is configured *and* able to run —
    not whether the operator would like one. It is resolved by the caller from
    `OCR_ENABLED` and from the engines actually answering, because those are two
    different things and only the second one can read a page. When it is false
    the Phase 07 refusal applies unchanged: a document that is mostly imaged is
    failed with `needs_ocr` rather than parsed into silence.

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

    inspection = DocumentInspection(
        page_count=page_count,
        pages=geometries,
        coverage=coverage,
        tiers=[classify_page_tier(score, threshold=coverage_threshold) for score in coverage],
    )
    if not ocr_available:
        require_text_layer(inspection, coverage_threshold)
    else:
        imaged = inspection.pages_in_tier(PageTier.ocr)
        if imaged:
            logger.info(
                "pages tiered for recognition",
                extra={
                    "pages": inspection.page_count,
                    "ocr_pages": len(imaged),
                    "threshold": coverage_threshold,
                },
            )
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


def require_text_layer(inspection: DocumentInspection, threshold: float) -> None:
    """Refuse a document the standard tier cannot read honestly.

    The Phase 07 rule, unchanged, and still reachable two ways: at inspection
    time when recognition is switched off, and from the parse pipeline when it
    is switched on but no engine could actually be loaded. The second is why
    this is public — "configured" and "working" are different states, and only
    the caller that tried to build an engine knows which one it is in.
    """
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
        "That document has little or no selectable text — it looks like a scan, "
        "and text recognition is switched off on this instance. Set OCR_ENABLED "
        "to read scanned documents, or upload a PDF with a text layer.",
    )
