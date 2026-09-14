"""The OCR tier: scanned pages in, located artifact elements out.

This is where the four modules beside it are composed, and where the coordinate
story ends. The chain, per page:

    render at OCR_DPI  ──►  preprocess  ──►  engine (+ fallback)
        (pixels, visible frame)   (pixels, deskewed frame)
      ──►  back through Preprocessed.to_source  ──►  scale by 72/dpi
      ──►  PageGeometry.normalize(rotated=True)  ──►  bbox in the convention

Three properties of that chain are load-bearing and none is obvious:

**PDFium renders the rotated page.** `/Rotate` is applied before the bitmap
exists, so a pixel coordinate is already in the visible frame — which is the
frame `docs/coordinates.md` stores boxes in. That is why `normalize` is called
with `rotated=True` and why there is no rotation arithmetic here. A 90° scan is
handled by the renderer, not by a special case.

**The deskew is undone before the conversion.** Recognition happens on a
straightened page; storage happens on the page as it exists. `to_source` is the
bridge, and without it every highlight on a skewed scan is wrong by the skew
angle.

**The DPI used is the one that was rendered, not the one that was asked for.**
An oversized page is rendered smaller to stay inside the memory ceiling, and
`RasterPage.dpi` records what actually happened.

The fallback rule is the one the phase specifies, with one addition: the
fallback's result is taken only when it is *better*. An engine that is reached
because the primary was unsure and then does worse has told us something, and
overwriting a 0.60 page with a 0.31 one because the fallback ran last would be
the wrong reading of it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.artifact import ElementType, ParsedElement
from konusbitr_worker.parse.geometry import BBox, CoordOrigin, PageGeometry
from konusbitr_worker.parse.ocr.engines import (
    OcrResult,
    RapidOcrEngine,
    RapidOcrOptions,
    TesseractEngine,
    TesseractOptions,
)
from konusbitr_worker.parse.ocr.layout import OcrBlock, group_blocks, group_lines
from konusbitr_worker.parse.ocr.preprocess import Preprocessed, preprocess
from konusbitr_worker.parse.ocr.raster import RasterPage, render_pages

__all__ = ["OcrOptions", "OcrPageResult", "OcrPipeline", "ocr_pages"]

logger = get_logger("konusbitr.worker.parse.ocr")


@dataclass(frozen=True, slots=True)
class OcrOptions:
    """Everything the OCR tier is configured with, resolved from `Settings`."""

    dpi: float = 300.0
    #: Primary-engine confidence below which the fallback is tried.
    fallback_threshold: float = 0.65
    #: Page confidence below which the page is kept but flagged in the viewer.
    #: Not a failure: a 40%-confident page of a faint carbon copy is still the
    #: best reading of that page anyone has, and refusing it leaves the reader
    #: with nothing rather than with something to check.
    low_confidence_threshold: float = 0.85
    deskew_enabled: bool = True
    fallback_enabled: bool = True
    languages: str = "eng"
    threads: int = 4

    def rapid(self) -> RapidOcrOptions:
        return RapidOcrOptions(threads=self.threads)

    def tesseract(self) -> TesseractOptions:
        return TesseractOptions(languages=self.languages)


@dataclass(slots=True)
class OcrPageResult:
    """One page's recognised content, in the Konusbitr coordinate convention."""

    page_no: int
    #: Paragraph-shaped elements, in reading order. Ids are assigned by the
    #: caller, which is the only thing that knows where these sit in the
    #: document as a whole.
    blocks: list[tuple[str, BBox, float]] = field(default_factory=list)
    confidence: float = 0.0
    engine: str = ""
    #: Degrees of skew that were corrected. Diagnostic; nothing branches on it.
    deskew_degrees: float = 0.0

    @property
    def text(self) -> str:
        return "\n\n".join(text for text, _bbox, _score in self.blocks if text)

    def elements(self, *, first_index: int) -> list[ParsedElement]:
        """The artifact elements for this page, numbered from `first_index`.

        Everything is a `paragraph`. The OCR tier has no layout model: it knows
        where ink is and what it says, and it does not know that a line in
        larger type at the top of a page is a heading. Guessing would put wrong
        `sectionPath` values on every chunk of a scanned document, and a wrong
        section path is worse than an absent one — it is a claim about the
        document's structure that the document does not support. Phase 12.3's
        VLM tier is where structure on a scan comes from.
        """
        from konusbitr_worker.parse.artifact import element_id

        return [
            ParsedElement(
                id=element_id(first_index + offset),
                type=ElementType.paragraph,
                text=text,
                markdown=text,
                page=self.page_no,
                bbox=bbox,
            )
            for offset, (text, bbox, _score) in enumerate(self.blocks)
        ]


class OcrPipeline:
    """The primary engine, the fallback, and the rule that chooses between them.

    Holds both engines for the life of a job rather than a page: `onnxruntime`
    loading three graphs is a few hundred milliseconds, and a fifty-page scan
    would otherwise pay it fifty times.
    """

    def __init__(
        self,
        options: OcrOptions | None = None,
        *,
        primary: object | None = None,
        fallback: object | None = None,
    ) -> None:
        self.options = options or OcrOptions()
        self.primary = primary or RapidOcrEngine(self.options.rapid())
        self.fallback = fallback or TesseractEngine(self.options.tesseract())

    def available(self) -> bool:
        """Whether any engine can run. False means the OCR tier is not installed."""
        return bool(self.primary.available()) or bool(self.fallback.available())  # type: ignore[attr-defined]

    def process_page(self, image: object, *, binary: object | None = None) -> OcrResult:
        """Recognise one preprocessed page, with the fallback rule applied.

        `binary` is the thresholded copy of the same page. Tesseract reads it
        and RapidOCR does not — see the module docstring of
        :mod:`konusbitr_worker.parse.ocr.preprocess` for why the two engines are
        handed different images from one geometric pipeline.
        """
        result = self.primary.run(image)  # type: ignore[attr-defined]
        if result.confidence >= self.options.fallback_threshold:
            return result
        if not self.options.fallback_enabled:
            return result

        fallback = self.fallback  # type: ignore[assignment]
        if not fallback.available():  # type: ignore[attr-defined]
            return result

        alternative = fallback.run(binary if binary is not None else image)  # type: ignore[attr-defined]
        if alternative.confidence <= result.confidence:
            logger.debug(
                "the OCR fallback did not improve on the primary engine",
                extra={
                    "primary": round(result.confidence, 3),
                    "fallback": round(alternative.confidence, 3),
                },
            )
            return result

        logger.info(
            "OCR fallback improved a page",
            extra={
                "primary": round(result.confidence, 3),
                "fallback": round(alternative.confidence, 3),
            },
        )
        return alternative

    def run_page(self, raster: RasterPage, geometry: PageGeometry) -> OcrPageResult:
        """Preprocess, recognise, and convert one rendered page into the convention."""
        prepared = preprocess(
            raster.image,
            dpi=raster.dpi,
            deskew_enabled=self.options.deskew_enabled,
        )
        result = self.process_page(prepared.image, binary=prepared.binary)

        blocks = group_blocks(group_lines(result.words))
        return OcrPageResult(
            page_no=raster.page_no,
            blocks=[
                converted
                for block in blocks
                if (converted := _convert(block, prepared, raster, geometry)) is not None
            ],
            confidence=result.confidence,
            engine=result.engine,
            deskew_degrees=prepared.deskew_degrees,
        )


def _convert(
    block: OcrBlock,
    prepared: Preprocessed,
    raster: RasterPage,
    geometry: PageGeometry,
) -> tuple[str, BBox, float] | None:
    """One block's text and its bbox in points, or `None` if it holds nothing."""
    text = block.text
    if not text:
        return None

    source = prepared.box_to_source(block.box)
    scale = raster.scale
    points = (source[0] * scale, source[1] * scale, source[2] * scale, source[3] * scale)

    # `rotated=True`: PDFium applied `/Rotate` when it rendered the bitmap, so
    # this box is already in the visible frame and must not be turned again.
    bbox = geometry.normalize(points, origin=CoordOrigin.top_left, rotated=True)
    if bbox.is_degenerate:
        return None
    return text, bbox, block.confidence


def ocr_pages(
    path: Path,
    pages: list[int],
    *,
    geometries: dict[int, PageGeometry],
    options: OcrOptions,
    pipeline: OcrPipeline | None = None,
) -> list[OcrPageResult]:
    """Recognise the named pages of a PDF. Synchronous and CPU-bound.

    The caller runs this on a thread and owns the ordering: results come back in
    the order the pages were asked for, and it is the parse pipeline that
    interleaves them with Docling's native-tier elements.
    """
    if not pages:
        return []

    engine = pipeline or OcrPipeline(options)
    results: list[OcrPageResult] = []

    for raster in render_pages(path, pages, dpi=options.dpi):
        geometry = geometries.get(raster.page_no)
        if geometry is None:  # pragma: no cover - the inspection produced these
            continue
        result = engine.run_page(raster, geometry)
        logger.info(
            "page recognised",
            extra={
                "page": result.page_no,
                "engine": result.engine,
                "confidence": round(result.confidence, 3),
                "blocks": len(result.blocks),
                "deskew_degrees": round(result.deskew_degrees, 2),
            },
        )
        results.append(result)

    return results
