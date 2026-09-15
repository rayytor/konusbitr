"""The OCR tier: reading pages that have no text layer.

Phase 07 refused a scan with `needs_ocr` rather than parsing it into silence,
which was the right call with no recogniser available and the wrong state to
leave the product in: real corpora are mostly scanned agreements, stamped
receipts and mixed PDFs where three pages of a hundred are photocopies. This
package is what turns that refusal into a second tier.

Seven modules, each with one job:

- :mod:`raster` renders a page to pixels with PDFium, at a DPI both engines can
  read, and records what it actually rendered at.
- :mod:`preprocess` makes a degraded scan legible — upscale, deskew, denoise,
  binarise — and keeps the affine map back to where the pixels came from.
- :mod:`engines` is RapidOCR and Tesseract behind one interface, speaking
  pixels.
- :mod:`layout` rebuilds the lines and paragraphs a recogniser discards, in
  either reading direction.
- :mod:`languages` decides which engine and which dictionary read a document,
  from `settings.langList` or from what `fast-langdetect` makes of its text.
- :mod:`tables` recovers a ruled table's grid from the page's own ruling lines
  and puts the recognised words back into cells.
- :mod:`pipeline` composes the rest and converts the result into the one
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
from konusbitr_worker.parse.ocr.languages import (
    LanguagePlan,
    detect_languages,
    normalize_tags,
    plan_languages,
)
from konusbitr_worker.parse.ocr.pipeline import (
    OcrElement,
    OcrOptions,
    OcrPageResult,
    OcrPipeline,
    RecognizedWord,
    ocr_pages,
)
from konusbitr_worker.parse.ocr.tables import TableGrid, detect_tables

__all__ = [
    "LanguagePlan",
    "OcrElement",
    "OcrOptions",
    "OcrPageResult",
    "OcrPipeline",
    "OcrResult",
    "OcrWord",
    "RapidOcrEngine",
    "RapidOcrOptions",
    "RecognizedWord",
    "TableGrid",
    "TesseractEngine",
    "TesseractOptions",
    "detect_languages",
    "detect_tables",
    "normalize_tags",
    "ocr_pages",
    "plan_languages",
]
