"""Tier 3: read a page by looking at it, then make it tell the truth.

The chain, per page:

    render at VLM_DPI  ──►  PNG  ──►  vision router  ──►  JSON
      ──►  parse_response: elements, boxes in the convention
      ──►  reconcile against the text layer or the confident OCR words
      ──►  artifact elements, tier `vlm`

Two properties of that chain are the reason it exists and neither is obvious.

**It is not a better OCR.** The standard tiers already read characters well —
Docling from a font, RapidOCR from a raster. What neither can do is say that the
sidebar is read after the second column and before the footnote, or that a line
in larger type is an `h2` rather than a paragraph. Structure and reading order
are the product here, and the text is reconciled away precisely so that the
model is never trusted with the part it is bad at.

**Every page costs money and time.** So the pages are chosen rather than
swept: `quality: "advanced"` asks for the whole document, and the automatic
escalation takes only pages the recogniser read badly. Both are capped by
`MAX_VLM_PAGES_PER_JOB`, and the cap is a refusal at intake rather than a
truncation half-way through — a job that stops after thirty pages has already
spent what the cap was meant to save.

Under `OFFLINE_MODE` this routes to the local vision model exactly as the
caption path does: the check is at boot, where a cloud provider named for any
role fails the process, and again at `resolve_vision_model`, because
configuration can change under a running process. There is no branch here that
knows about offline mode, which is the point — it cannot be forgotten in one.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from konusbitr_worker.ai.vision import VisionRouter
from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.artifact import ParsedElement, element_id
from konusbitr_worker.parse.geometry import PageGeometry
from konusbitr_worker.parse.ocr.raster import render_pages
from konusbitr_worker.parse.textlayer import TextWord
from konusbitr_worker.parse.vlm.reconcile import ReconciliationReport, reconcile_page
from konusbitr_worker.parse.vlm.response import VlmElement, parse_response
from konusbitr_worker.prompts import load_prompt

__all__ = ["VLM_PARSE_PROMPT", "VlmOptions", "VlmPageResult", "read_pages"]

logger = get_logger("konusbitr.worker.parse.vlm")

#: The versioned prompt. Never an inline literal: a change in an eval score has
#: to be attributable to a change in a prompt. See `packages/ai/prompts/`.
VLM_PARSE_PROMPT = "vlm.parse.v1"

#: The turn that carries the page. The instructions are in the system prompt.
_USER_TURN = "Transcribe this page into structured elements."

_IMAGE_MEDIA_TYPE = "image/png"


@dataclass(frozen=True, slots=True)
class VlmOptions:
    """Everything the VLM tier is configured with, resolved from `Settings`."""

    dpi: float = 180.0
    max_tokens: int = 1500
    #: Pages read at once. Small: these are whole page images on the wire.
    concurrency: int = 3
    #: Longest edge the page image is downscaled to before it is sent. Every
    #: provider resamples above roughly this, so sending more costs tokens.
    max_edge: int = 1568


@dataclass(slots=True)
class VlmPageResult:
    """One page as the vision model read it, after reconciliation."""

    page_no: int
    elements: list[VlmElement] = field(default_factory=list)
    report: ReconciliationReport = field(default_factory=ReconciliationReport)
    #: Set when the model could not be reached or answered with nothing usable.
    #: The caller keeps the standard tier's reading of the page in that case.
    failed: bool = False

    def elements_for_artifact(self, *, first_index: int) -> list[ParsedElement]:
        """This page's elements, numbered from `first_index`, in reading order.

        Unlike the OCR tier this does emit `heading`, and that is the whole
        point of the tier: headings on a scan were explicitly deferred from
        Phase 12.1 to here, because a layout model is what it takes to know that
        a line in larger type is a section title rather than a sentence. The
        `sectionPath` those headings produce is built downstream, over the
        merged document, so a heading found here scopes the born-digital pages
        that follow it too.
        """
        return [
            ParsedElement(
                id=element_id(first_index + offset),
                type=element.type,
                text=element.text,
                markdown=element.markdown,
                page=self.page_no,
                bbox=element.bbox,
                level=element.level,
                table=element.table,
            )
            for offset, element in enumerate(self.elements)
        ]


async def read_pages(
    path: Path,
    pages: Sequence[int],
    *,
    geometries: dict[int, PageGeometry],
    truth: dict[int, list[TextWord]],
    router: VisionRouter,
    options: VlmOptions,
) -> list[VlmPageResult]:
    """Read the named pages with the vision model. Results in page order.

    `truth` is the reconciliation source per page: the PDF's own text layer for
    a born-digital page, the confidently-recognised words for a scanned one, and
    an empty list for a page that has neither — which is a supported state and
    comes back as `grounded=False` elements rather than as a failure.

    Rendering happens on a thread (PDFium is synchronous and CPU-bound) and the
    inference happens on the loop, bounded by a semaphore. Pages are rendered in
    batches the size of the concurrency limit rather than all at once: a 300 DPI
    page is ~25MB decoded, and materialising fifty of them before the first
    request returns makes peak memory a function of the page count.
    """
    if not pages:
        return []

    system = load_prompt(VLM_PARSE_PROMPT)
    limiter = asyncio.Semaphore(max(1, options.concurrency))
    results: list[VlmPageResult] = []

    batch_size = max(1, options.concurrency)
    for start in range(0, len(pages), batch_size):
        window = list(pages[start : start + batch_size])
        rendered = await asyncio.to_thread(_render, path, window, options)

        batch = await asyncio.gather(
            *(
                _read_one(
                    page_no=page_no,
                    image=image,
                    geometry=geometries[page_no],
                    truth=truth.get(page_no, []),
                    router=router,
                    system=system,
                    options=options,
                    limiter=limiter,
                )
                for page_no, image in rendered
                if page_no in geometries
            )
        )
        results.extend(batch)

    return results


def _render(path: Path, pages: list[int], options: VlmOptions) -> list[tuple[int, bytes]]:
    """Render pages to PNG bytes at the configured DPI, capped on the long edge.

    The cap is what makes the cost estimate a function of the page *count*: an
    A0 poster and a Letter page both arrive at the model as roughly the same
    number of pixels, because every provider resamples to about this size before
    it looks. Sending more is paying for tokens that get thrown away.
    """
    import io

    from PIL import Image

    images: list[tuple[int, bytes]] = []
    for raster in render_pages(path, pages, dpi=options.dpi):
        image = Image.fromarray(raster.image)
        longest = max(image.width, image.height)
        if longest > options.max_edge:
            scale = options.max_edge / longest
            image = image.resize(
                (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
                Image.LANCZOS,
            )
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=True)
        images.append((raster.page_no, buffer.getvalue()))
    return images


async def _read_one(
    *,
    page_no: int,
    image: bytes,
    geometry: PageGeometry,
    truth: list[TextWord],
    router: VisionRouter,
    system: str,
    options: VlmOptions,
    limiter: asyncio.Semaphore,
) -> VlmPageResult:
    """One page: ask, parse, reconcile. Never raises.

    A page the model could not read is a page the standard tier already read —
    Docling's elements or the recogniser's are still in hand — so a provider
    outage degrades the *structure* of one page rather than failing a document.
    That is the same trade the caption path makes, for the same reason: the
    parse of the text is what the upload was for.
    """
    async with limiter:
        try:
            answer = await router.read_page(
                system=system,
                prompt=_USER_TURN,
                image=image,
                media_type=_IMAGE_MEDIA_TYPE,
                max_tokens=options.max_tokens,
            )
        except Exception:
            # Named by page only. A provider's error text can echo what it was
            # sent, and document content never reaches telemetry.
            logger.warning(
                "the vision model could not read a page",
                extra={"page": page_no},
                exc_info=True,
            )
            return VlmPageResult(page_no=page_no, failed=True)

    elements = parse_response(answer, geometry)
    if not elements:
        logger.info("the vision model returned no usable elements", extra={"page": page_no})
        return VlmPageResult(page_no=page_no, failed=True)

    report = reconcile_page(elements, truth)
    logger.info(
        "page read by the vision model",
        extra={
            "page": page_no,
            "model": router.model_name,
            "truth_words": len(truth),
            **report.to_json(),
        },
    )
    return VlmPageResult(page_no=page_no, elements=elements, report=report)
