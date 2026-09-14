"""The OCR tier: reading pages that have no text layer.

Phase 07 refused a scan with `needs_ocr` rather than parsing it into silence,
which was the right call with no recogniser available and the wrong state to
leave the product in: real corpora are mostly scanned agreements, stamped
receipts and mixed PDFs where three pages of a hundred are photocopies. This
package is what turns that refusal into a second tier.

Five modules, each with one job:

- :mod:`raster` renders a page to pixels with PDFium, at a DPI both engines can
  read, and records what it actually rendered at.
- :mod:`preprocess` makes a degraded scan legible — upscale, deskew, denoise,
  binarise — and keeps the affine map back to where the pixels came from.
- :mod:`engines` is RapidOCR and Tesseract behind one interface, speaking
  pixels.
- :mod:`layout` rebuilds the lines and paragraphs a recogniser discards.
- :mod:`pipeline` composes the four and converts the result into the one
  coordinate convention.

Nothing here decides *whether* a page is scanned. That is
:mod:`konusbitr_worker.parse.inspect`, which tiers every page before a bitmap is
rendered, so a hundred-page document with three scanned attachments pays for
three pages of OCR and not for a hundred.

Every dependency is Apache-2.0, MIT or BSD-3. That is a constraint on this
package specifically: the obvious alternatives — PyMuPDF for rendering, Marker
for the whole pipeline — are AGPL, and the default Konusbitr build has to stay
cleanly permissive. `tests/test_licensing.py` fails the build if that ever
stops being true.
"""

from __future__ import annotations

from konusbitr_worker.parse.ocr.engines import (
    OcrResult,
    OcrWord,
    RapidOcrEngine,
    RapidOcrOptions,
    TesseractEngine,
    TesseractOptions,
)
from konusbitr_worker.parse.ocr.pipeline import (
    OcrOptions,
    OcrPageResult,
    OcrPipeline,
    ocr_pages,
)

__all__ = [
    "OcrOptions",
    "OcrPageResult",
    "OcrPipeline",
    "OcrResult",
    "OcrWord",
    "RapidOcrEngine",
    "RapidOcrOptions",
    "TesseractEngine",
    "TesseractOptions",
    "ocr_pages",
]
