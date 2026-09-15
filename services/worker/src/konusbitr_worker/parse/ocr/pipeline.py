"""The OCR tier: scanned pages in, located artifact elements out.

This is where the modules beside it are composed, and where the coordinate
story ends. The chain, per page:

    render at OCR_DPI  ──►  preprocess  ──►  engine (+ fallback)
        (pixels, visible frame)   (pixels, deskewed frame)
      ──►  ruled-table grids, then paragraphs from what is left
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

Phase 12.2 adds two things to that picture and changes nothing else about it.
**Which engine is primary is now a per-document decision**, taken by
:mod:`konusbitr_worker.parse.ocr.languages` from `settings.langList` or from
what the identifier made of the document: Arabic and Turkish go to Tesseract's
language packs, Latin and Chinese stay on PP-OCRv4. And **ruled tables are
lifted out before the words are grouped into paragraphs**, so a scanned balance
sheet arrives downstream as a `table` element with cells rather than as prose
that happens to contain numbers.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.artifact import (
    ElementType,
    ParsedElement,
    TableCellData,
    TableData,
    element_id,
    markdown_table,
)
from konusbitr_worker.parse.geometry import BBox, CoordOrigin, PageGeometry
from konusbitr_worker.parse.ocr.engines import (
    OcrResult,
    RapidOcrEngine,
    RapidOcrOptions,
    TesseractEngine,
    TesseractOptions,
)
from konusbitr_worker.parse.ocr.languages import LanguagePlan, plan_languages
from konusbitr_worker.parse.ocr.layout import OcrBlock, group_blocks, group_lines
from konusbitr_worker.parse.ocr.preprocess import Preprocessed, preprocess
from konusbitr_worker.parse.ocr.raster import RasterPage, render_pages
from konusbitr_worker.parse.ocr.tables import TableGrid, assign_words, detect_tables

__all__ = ["OcrElement", "OcrOptions", "OcrPageResult", "OcrPipeline", "ocr_pages"]

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
    #: The `OCR_LANGUAGES` floor. Used when no plan resolves — which is what a
    #: caller constructing `OcrOptions` by hand gets.
    languages: str = "eng"
    threads: int = 4
    #: `settings.langList` from the job payload, verbatim. Empty is the default
    #: and means "work it out", which is what `resolve` does.
    requested_languages: tuple[str, ...] = ()
    #: Where alternative RapidOCR recognition heads live, if an operator has
    #: installed any. `OCR_MODEL_DIR`.
    model_dir: str | None = None
    #: Which engine and which dictionaries this document is read with. Resolved
    #: per document by :func:`konusbitr_worker.parse.ocr.languages.plan_languages`.
    plan: LanguagePlan = field(default_factory=LanguagePlan)
    #: Whether ruled tables are reconstructed rather than read as prose.
    tables_enabled: bool = True

    def rapid(self) -> RapidOcrOptions:
        return RapidOcrOptions(
            threads=self.threads,
            rec_model_path=self.plan.rapid_model_path,
            rec_keys_path=self.plan.rapid_keys_path,
        )

    def tesseract(self) -> TesseractOptions:
        return TesseractOptions(languages=self.plan.tesseract_languages or self.languages)

    def resolve(self, sample: str) -> LanguagePlan:
        """The dispatch decision for a document, given whatever text it has yielded."""
        return plan_languages(
            requested=self.requested_languages,
            sample=sample,
            model_dir=self.model_dir,
            default_tesseract=self.languages,
        )


@dataclass(slots=True)
class OcrElement:
    """One thing found on a recognised page: a paragraph, or a table.

    Carries its own markdown because the two kinds render differently and the
    caller that composes a document's markdown should not have to know which is
    which — see `markdown_from_elements`.
    """

    type: ElementType
    text: str
    markdown: str
    bbox: BBox
    confidence: float = 0.0
    table: TableData | None = None


@dataclass(slots=True)
class OcrPageResult:
    """One page's recognised content, in the Konusbitr coordinate convention."""

    page_no: int
    #: Paragraphs and tables, in reading order. Ids are assigned by the caller,
    #: which is the only thing that knows where these sit in the document as a
    #: whole.
    elements: list[OcrElement] = field(default_factory=list)
    confidence: float = 0.0
    engine: str = ""
    #: Degrees of skew that were corrected. Diagnostic; nothing branches on it.
    deskew_degrees: float = 0.0
    #: How many ruled tables were reconstructed on this page. Diagnostic.
    tables: int = 0

    @property
    def text(self) -> str:
        return "\n\n".join(element.text for element in self.elements if element.text)

    def elements_for_artifact(self, *, first_index: int) -> list[ParsedElement]:
        """The artifact elements for this page, numbered from `first_index`.

        Prose is `paragraph` and nothing else. The OCR tier has no layout model:
        it knows where ink is and what it says, and it does not know that a line
        in larger type at the top of a page is a heading. Guessing would put
        wrong `sectionPath` values on every chunk of a scanned document, and a
        wrong section path is worse than an absent one — it is a claim about the
        document's structure that the document does not support. Phase 12.3's
        VLM tier is where structure on a scan comes from.

        A `table` is the one exception, and it is an exception because it is not
        a guess: the grid was printed on the page and
        :mod:`konusbitr_worker.parse.ocr.tables` read it off the ruling lines.
        """
        return [
            ParsedElement(
                id=element_id(first_index + offset),
                type=element.type,
                text=element.text,
                markdown=element.markdown,
                page=self.page_no,
                bbox=element.bbox,
                table=element.table,
            )
            for offset, element in enumerate(self.elements)
        ]


class OcrPipeline:
    """The two engines, the rule that chooses between them, and the language plan.

    Holds both engines for the life of a job rather than a page: `onnxruntime`
    loading two graphs is a few hundred milliseconds, and a fifty-page scan
    would otherwise pay it fifty times.

    Which one is *primary* is the Phase 12.2 change. It is decided once, from
    the document's language, and it is decided here rather than inside
    `process_page` so that a page cannot silently be read by a different engine
    than the one the page before it was.
    """

    def __init__(
        self,
        options: OcrOptions | None = None,
        *,
        primary: object | None = None,
        fallback: object | None = None,
    ) -> None:
        self.options = options or OcrOptions()

        rapid = RapidOcrEngine(self.options.rapid())
        tesseract = TesseractEngine(self.options.tesseract())
        if self.options.plan.prefer_tesseract:
            # Arabic, Hebrew, Devanagari, Thai — and Turkish and Vietnamese
            # when the Latin PP-OCR head is not installed. See
            # `konusbitr_worker.parse.ocr.languages`.
            default_primary: object = tesseract
            default_fallback: object = rapid
        else:
            default_primary, default_fallback = rapid, tesseract

        self.primary = primary or default_primary
        self.fallback = fallback or default_fallback

    def available(self) -> bool:
        """Whether any engine can run. False means the OCR tier is not installed."""
        return bool(self.primary.available()) or bool(self.fallback.available())  # type: ignore[attr-defined]

    def retune(self, plan: LanguagePlan) -> bool:
        """Adopt a resolved language plan. Returns whether the dispatch changed.

        The return value is what tells the caller whether the page it has
        already read has to be read again. It is `False` for every English and
        Chinese document, which is the case that must stay free: nothing is
        rebuilt, nothing is reloaded, and the page recognised during language
        identification is kept.

        The ONNX graphs are rebuilt only when the plan asks for a *different
        recognition head*. Swapping which engine is primary does not need it —
        both objects already exist — and rebuilding Tesseract is free, since
        the engine is a subprocess and the object holds only its arguments.
        """
        current = self.options.plan
        if (
            plan.rapid_model_path == current.rapid_model_path
            and plan.rapid_keys_path == current.rapid_keys_path
            and plan.tesseract_languages == current.tesseract_languages
            and plan.prefer_tesseract == current.prefer_tesseract
            and plan.rtl == current.rtl
        ):
            self.options = replace(self.options, plan=plan)
            return False

        rapid = self._engine_named(RapidOcrEngine.name)
        self.options = replace(self.options, plan=plan)

        if (
            rapid is None
            or plan.rapid_model_path != current.rapid_model_path
            or plan.rapid_keys_path != current.rapid_keys_path
        ):
            rapid = RapidOcrEngine(self.options.rapid())
        tesseract = TesseractEngine(self.options.tesseract())

        if plan.prefer_tesseract:
            self.primary, self.fallback = tesseract, rapid
        else:
            self.primary, self.fallback = rapid, tesseract
        return True

    def _engine_named(self, name: str) -> Any | None:
        """Whichever slot currently holds the engine called `name`, if either does.

        Looked up by name rather than by slot because the slots swap: after one
        `retune` the primary may be Tesseract, and a second `retune` back to a
        Latin document must recover the already-loaded RapidOCR rather than
        building a third one.
        """
        for engine in (self.primary, self.fallback):
            if getattr(engine, "name", None) == name:
                return engine
        return None

    def process_page(self, image: object, *, binary: object | None = None) -> OcrResult:
        """Recognise one preprocessed page, with the fallback rule applied.

        `binary` is the thresholded copy of the same page. Which images an
        engine is given is a property of the engine rather than of the slot —
        see `OcrEngine.preparations` and the module docstring of
        :mod:`konusbitr_worker.parse.ocr.preprocess`.
        """
        result = self.read(self.primary, image, binary)
        if result.confidence >= self.options.fallback_threshold:
            return result
        if not self.options.fallback_enabled:
            return result

        fallback = self.fallback
        if not fallback.available():  # type: ignore[attr-defined]
            return result

        alternative = self.read(fallback, image, binary)
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

    def read(self, engine: Any, image: object, binary: object | None) -> OcrResult:
        """One engine's best reading of a page, across the preparations it wants.

        An engine that names one preparation is run once, which is the ordinary
        case. Tesseract names two and both are read, because neither dominates —
        see `TesseractEngine.preparations` for the two fixtures that pull in
        opposite directions.
        """
        best: OcrResult | None = None
        for name in getattr(engine, "preparations", ("image",)):
            prepared = binary if name == "binary" and binary is not None else image
            result = engine.run(prepared)
            if best is None:
                best = result
                continue
            best = _better(best, result, floor=self.options.fallback_threshold)
        return best if best is not None else OcrResult(engine=getattr(engine, "name", ""))

    def run_page(self, raster: RasterPage, geometry: PageGeometry) -> OcrPageResult:
        """Preprocess, recognise, and convert one page into the convention."""
        prepared = preprocess(
            raster.image,
            dpi=raster.dpi,
            deskew_enabled=self.options.deskew_enabled,
        )
        result = self.process_page(prepared.image, binary=prepared.binary)

        grids: list[TableGrid] = []
        words = result.words
        if self.options.tables_enabled:
            grids = detect_tables(prepared.binary)
            # Partitioned, not copied: a number that appeared in both a table
            # chunk and a prose chunk would be retrieved twice and cited from
            # whichever won, pointing at two different rectangles.
            words = assign_words(grids, words)
            grids = [grid for grid in grids if grid.has_content]

        rtl = self.options.plan.rtl
        elements: list[OcrElement] = [
            converted
            for block in group_blocks(group_lines(words, rtl=rtl), rtl=rtl)
            if (converted := _paragraph(block, prepared, raster, geometry)) is not None
        ]
        elements.extend(
            converted
            for grid in grids
            if (converted := _table(grid, prepared, raster, geometry, rtl=rtl)) is not None
        )
        # One reading order over both kinds. The two were produced by separate
        # passes over the same page, and a table that sits between two
        # paragraphs has to land between them in `contents` — the chunker keys
        # reading order off this list's order and nothing re-sorts it later.
        elements.sort(key=lambda element: (element.bbox.y0, element.bbox.x0))

        return OcrPageResult(
            page_no=raster.page_no,
            elements=elements,
            confidence=result.confidence,
            engine=result.engine,
            deskew_degrees=prepared.deskew_degrees,
            tables=len(grids),
        )


def _better(first: OcrResult, second: OcrResult, *, floor: float) -> OcrResult:
    """Which of two readings of the same page to keep.

    **Not simply the more confident one.** The case this exists for is a
    preparation that loses a whole line and is entirely sure about the lines it
    kept: the Arabic fixture's binarised page comes back at 0.921 with two of
    its four lines missing, and its greyscale comes back at 0.921 with all four.
    A confidence comparison cannot see the difference, because confidence is a
    statement about what was recognised and says nothing about what was not.

    So the tie-break is *how much was read*, with confidence as a floor rather
    than as the measure: a reading below the fallback threshold loses to one
    above it however much text it produced, which is what stops a preparation
    that turns a page into plausible noise from winning on volume.
    """
    first_ok = first.confidence >= floor
    second_ok = second.confidence >= floor
    if first_ok != second_ok:
        return first if first_ok else second

    first_chars = sum(len(word.text.strip()) for word in first.words)
    second_chars = sum(len(word.text.strip()) for word in second.words)
    if first_chars != second_chars:
        return first if first_chars > second_chars else second

    return first if first.confidence >= second.confidence else second


def _to_points(
    box: tuple[float, float, float, float],
    prepared: Preprocessed,
    raster: RasterPage,
    geometry: PageGeometry,
) -> BBox:
    """One pixel box, in the Konusbitr convention. The only conversion in this tier."""
    source = prepared.box_to_source(box)
    scale = raster.scale
    points = (source[0] * scale, source[1] * scale, source[2] * scale, source[3] * scale)
    # `rotated=True`: PDFium applied `/Rotate` when it rendered the bitmap, so
    # this box is already in the visible frame and must not be turned again.
    return geometry.normalize(points, origin=CoordOrigin.top_left, rotated=True)


def _paragraph(
    block: OcrBlock,
    prepared: Preprocessed,
    raster: RasterPage,
    geometry: PageGeometry,
) -> OcrElement | None:
    """One prose block as an element, or `None` if it holds nothing."""
    text = block.text
    if not text:
        return None

    bbox = _to_points(block.box, prepared, raster, geometry)
    if bbox.is_degenerate:
        return None
    return OcrElement(
        type=ElementType.paragraph,
        text=text,
        markdown=text,
        bbox=bbox,
        confidence=block.confidence,
    )


def _table(
    grid: TableGrid,
    prepared: Preprocessed,
    raster: RasterPage,
    geometry: PageGeometry,
    *,
    rtl: bool,
) -> OcrElement | None:
    """One reconstructed grid as a `table` element, markdown and JSON together.

    A table's "text" is its markdown, exactly as it is for a born-digital table:
    the cells are the content, and a concatenation of them with the row
    structure discarded would embed into something that retrieves for every
    number on the page.
    """
    bbox = _to_points(grid.box, prepared, raster, geometry)
    if bbox.is_degenerate:
        return None

    matrix = _matrix(grid, rtl=rtl)
    if not matrix:
        return None

    header_row = _looks_like_a_header(matrix)
    headers = matrix[0] if header_row else []
    rows = matrix[1:] if header_row else matrix

    cells = [
        TableCellData(
            row_index=cell.row,
            col_index=_display_column(cell.col, cell.col_span, grid.cols, rtl=rtl),
            text=cell.text,
            bbox=_to_points(cell.box, prepared, raster, geometry),
            row_span=cell.row_span,
            col_span=cell.col_span,
            header=header_row and cell.row == 0,
        )
        for cell in grid.cells
        # `_matrix` drops trailing empty rows — the margin between the last rule
        # and the table's border, which the contour finder includes and a reader
        # does not — so a cell there would carry a `rowIndex` past `numRows`.
        if cell.text and cell.row < len(matrix)
    ]

    table = TableData(headers=headers, rows=rows, cells=cells)
    markdown = markdown_table(headers, rows)
    if not markdown:
        return None

    confidence = [cell.confidence for cell in grid.cells if cell.words]
    return OcrElement(
        type=ElementType.table,
        text=markdown,
        markdown=markdown,
        bbox=bbox,
        confidence=sum(confidence) / len(confidence) if confidence else 0.0,
        table=table,
    )


def _matrix(grid: TableGrid, *, rtl: bool) -> list[list[str]]:
    """The grid as a dense list of rows, spans repeated into every cell they cover.

    Repeated rather than left blank because both consumers want it that way: a
    markdown table has no colspan, and Phase 13's `extract` addressing
    `rows[2][1]` should find the merged value rather than an empty string it
    then has to search leftwards for.
    """
    matrix = [["" for _ in range(grid.cols)] for _ in range(grid.rows)]
    for cell in grid.cells:
        text = cell.text
        for dy in range(cell.row_span):
            for dx in range(cell.col_span):
                row, col = cell.row + dy, cell.col + dx
                if 0 <= row < grid.rows and 0 <= col < grid.cols:
                    matrix[row][col] = text

    if rtl:
        # A right-to-left table's first column is its rightmost one. The grid
        # was built from pixel positions, which know nothing about that.
        matrix = [list(reversed(row)) for row in matrix]

    # Trailing all-empty rows are the margin between the last rule and the
    # border, which the contour finder includes and a reader does not.
    while matrix and not any(cell.strip() for cell in matrix[-1]):
        matrix.pop()
    return matrix


def _display_column(col: int, col_span: int, cols: int, *, rtl: bool) -> int:
    """A cell's column index as the matrix presents it, mirrored for RTL."""
    return cols - (col + col_span) if rtl else col


def _looks_like_a_header(matrix: list[list[str]]) -> bool:
    """Whether the first row names the columns rather than holding data.

    No declared header survives a scan — the page carries bold type and a shaded
    fill, and binarisation removes both — so this is a judgement made from the
    grid's contents alone, and the shape of the judgement matters.

    The obvious rule, "a header row contains no numbers", is wrong on the most
    common table this tier will ever meet: the column headings of a financial
    statement are years. So the test is per *column* instead, and it asks for
    one column in which the first row is a label and everything below it is a
    figure — `Change` over `42%`, `11%`, `7%`. That is the pattern that only a
    header produces, and it survives `2023` sitting in the next column along.

    Conservative in both directions. Every cell in the first row must carry
    text, so a grid whose top-left corner is blank — which is what a
    row-and-column-headed matrix looks like — is not misread as headed. And a
    table of nothing but words gets no header, which reads as an honest "this
    parser could not tell" rather than as a claim that the first row of data is
    a set of column names.
    """
    if len(matrix) < 2:
        return False

    first = matrix[0]
    if not first or any(not cell.strip() for cell in first):
        return False

    body = matrix[1:]
    for column, heading in enumerate(first):
        if _is_numeric(heading):
            continue
        values = [row[column] for row in body if column < len(row) and row[column].strip()]
        if values and all(_is_numeric(value) for value in values):
            return True
    return False


def _is_numeric(cell: str) -> bool:
    """Whether a cell is a figure rather than a label.

    Deliberately loose about currency symbols, thousands separators, percentage
    signs and parenthesised negatives, because a financial table is written in
    all of them and the question being asked is only "is this a number".
    """
    stripped = cell.strip().strip("()")
    # The no-break and narrow no-break spaces are how a typesetter writes a
    # thousands separator, and both survive recognition as themselves.
    for character in (
        "$",
        "\u20ac",
        "\u00a3",
        "\u00a5",
        "%",
        ",",
        "+",
        "-",
        " ",
        "\u00a0",
        "\u202f",
    ):
        stripped = stripped.replace(character, "")
    stripped = stripped.replace(".", "", 1)
    return bool(stripped) and stripped.isdigit()


def ocr_pages(
    path: Path,
    pages: list[int],
    *,
    geometries: dict[int, PageGeometry],
    options: OcrOptions,
    pipeline: OcrPipeline | None = None,
    sample: str = "",
) -> list[OcrPageResult]:
    """Recognise the named pages of a PDF. Synchronous and CPU-bound.

    The caller runs this on a thread and owns the ordering: results come back in
    the order the pages were asked for, and it is the parse pipeline that
    interleaves them with Docling's native-tier elements.

    `sample` is whatever text the document has already given up — the markdown
    of its born-digital pages on a mixed filing — and is what the language
    identifier reads. **A wholly scanned document has no such text**, which is
    the awkward case the phase's own flow diagram names: there is nothing to
    identify until something has been recognised, and nothing can be recognised
    until the language is known. It is broken by reading the first page with
    whatever the default dispatch is, identifying *that*, and re-reading the
    page only when the answer turns out to need a different engine. A page
    therefore costs double exactly once per document, and only for documents
    that were routed away from the default.
    """
    if not pages:
        return []

    engine = pipeline or OcrPipeline(options)
    results: list[OcrPageResult] = []

    resolved = bool(options.requested_languages) or bool(sample.strip())
    if resolved:
        engine.retune(engine.options.resolve(sample))

    for raster in render_pages(path, pages, dpi=options.dpi):
        geometry = geometries.get(raster.page_no)
        if geometry is None:  # pragma: no cover - the inspection produced these
            continue
        result = engine.run_page(raster, geometry)

        if not resolved:
            resolved = True
            if engine.retune(engine.options.resolve(result.text)):
                logger.info(
                    "re-reading the first page with the routed engine",
                    extra={"page": result.page_no, **engine.options.plan.describe()},
                )
                result = engine.run_page(raster, geometry)

        logger.info(
            "page recognised",
            extra={
                "page": result.page_no,
                "engine": result.engine,
                "confidence": round(result.confidence, 3),
                "elements": len(result.elements),
                "tables": result.tables,
                "deskew_degrees": round(result.deskew_degrees, 2),
            },
        )
        results.append(result)

    return results
