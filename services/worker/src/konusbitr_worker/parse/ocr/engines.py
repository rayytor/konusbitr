"""The two OCR engines, behind one interface, in pixels.

**RapidOCR is the primary.** It runs PP-OCRv4 detection and recognition as ONNX
graphs under `onnxruntime`, on the CPU, with the weights shipped inside the
wheel — no CUDA, no Hugging Face fetch at first use, no model directory to bake
into an image, and Apache-2.0 throughout. For a project whose default build must
stay permissively licensed and whose `OFFLINE_MODE` is a headline claim rather
than a configuration flag, that combination is the whole argument.

**Tesseract 5 is the fallback**, reached when RapidOCR's confidence on a page
falls below `OCR_FALLBACK_THRESHOLD`. It is a genuinely different family of
recogniser — LSTM over binarised connected components rather than a detector
plus a CRNN — so it fails on different pages, which is the only property that
makes a fallback worth running. It needs a system binary, and a deployment
without one keeps working with the primary engine alone rather than failing:
:meth:`TesseractEngine.available` is what makes that a supported state instead
of a crash on the first faint receipt.

Everything here speaks **pixels of the image it was handed**. Converting to
points, undoing the deskew and applying the page rotation all happen upstream in
:mod:`konusbitr_worker.parse.ocr.pipeline`, so that an engine added later has
one job and cannot get the coordinate convention wrong.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from konusbitr_worker.log import get_logger

__all__ = [
    "OcrResult",
    "OcrWord",
    "RapidOcrEngine",
    "RapidOcrOptions",
    "TesseractEngine",
    "TesseractOptions",
]

logger = get_logger("konusbitr.worker.parse.ocr.engines")


@dataclass(frozen=True, slots=True)
class OcrWord:
    """One recognised token, boxed in pixels of the image the engine read.

    "Word" is the unit both engines report and the unit a citation highlight
    ultimately wants. Lines and blocks are assembled from these in
    :mod:`konusbitr_worker.parse.ocr.layout`, and the word offsets survive that
    assembly so a highlight can be tighter than a paragraph.
    """

    text: str
    #: `(x0, y0, x1, y1)`, top-left origin, y down, in pixels.
    box: tuple[float, float, float, float]
    #: `0.0`-`1.0`. Both engines are normalised onto this scale here.
    confidence: float


@dataclass(slots=True)
class OcrResult:
    """What one engine made of one page."""

    words: list[OcrWord] = field(default_factory=list)
    #: The engine that produced this, for the log and the page row.
    engine: str = ""

    @property
    def text(self) -> str:
        return " ".join(word.text for word in self.words if word.text)

    @property
    def confidence(self) -> float:
        """Page confidence: the mean over words, weighted by their length.

        Weighted rather than flat because the two disagree in the case that
        matters. A page of clean prose with one misrecognised stamp in the
        corner is a good page; a flat mean lets the stamp — one short token —
        count as much as a full line, and a page whose real content is two
        headings and forty pieces of noise then scores the same as a page whose
        real content is forty lines and two pieces of noise.

        A page with no words at all is `0.0`, not `1.0`: recognising nothing is
        the worst outcome, and it is the one that must trip the fallback.
        """
        total = 0.0
        weight = 0.0
        for word in self.words:
            length = float(len(word.text.strip()))
            if length <= 0:
                continue
            total += word.confidence * length
            weight += length
        return total / weight if weight > 0 else 0.0


class OcrEngine(Protocol):
    """What the pipeline requires of a recogniser."""

    name: str
    #: Which of the images :mod:`konusbitr_worker.parse.ocr.preprocess` produces
    #: this engine is given, in the order they are tried. A property of the
    #: *engine*, not of the slot it occupies: since Phase 12.2 either engine can
    #: be the primary one, and a rule written as "the fallback gets the binary"
    #: would hand the thresholded page to whichever engine happened to be second.
    #:
    #: An engine naming more than one is read from each of them and the better
    #: reading is kept — see :meth:`OcrPipeline.read`.
    preparations: tuple[str, ...]

    def available(self) -> bool:
        """Whether this engine can run here. Checked once, cached by the caller."""
        ...

    def run(self, image: Any) -> OcrResult:
        """Recognise one page. Synchronous, CPU-bound, pixels in and pixels out."""
        ...


# ── RapidOCR ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class RapidOcrOptions:
    """The knobs worth exposing on PP-OCRv4, and nothing else.

    Deliberately small. RapidOCR accepts several dozen parameters covering model
    paths, CUDA providers and preprocessing that this pipeline has already done
    itself; surfacing them would turn tuning the OCR tier into tuning a second
    copy of the preprocessing chain.
    """

    #: Recognition score below which a token is dropped rather than stored. A
    #: token the model is 20% sure of is noise, and noise in a chunk is noise in
    #: the index — it retrieves, it cannot be verified against the page, and the
    #: citation machinery drops the claim built on it.
    text_score: float = 0.5
    #: Detection box score threshold. Lower finds more faint text and more
    #: paper grain with it.
    box_threshold: float = 0.5
    #: How far a detected box is dilated before recognition. PP-OCR's own
    #: default; too tight clips ascenders and descenders.
    unclip_ratio: float = 1.6
    #: Longest side, in pixels, that RapidOCR will detect on without shrinking
    #: the page first.
    #:
    #: **This has to be raised and it is not obvious why.** RapidOCR ships a
    #: default of 2000, which is right for the photographs of signage it was
    #: tuned on and wrong here: a Letter page rendered at the 300 DPI both
    #: engines want is 3300 pixels tall, so the default silently resamples it
    #: down to an effective 180 DPI before the detector ever sees it — undoing
    #: the one preprocessing decision that matters most. 4000 clears US Letter,
    #: A4 and Legal at 300 DPI; anything larger is still shrunk, and
    #: :class:`RasterPage` records the DPI it really rendered at so the
    #: coordinates survive either way.
    max_side_length: int = 4000
    #: Whether PP-OCR's 180-degree angle classifier runs on each detected line.
    #:
    #: **Off, and this is not a performance decision.** The classifier exists
    #: for photographs of signage, where a line's orientation is genuinely
    #: unknown. Here it is not: PDFium applied the page's `/Rotate` before the
    #: bitmap existed and the deskew straightened what was left, so every line
    #: reaching the recogniser is upright by construction.
    #:
    #: Left on, it misfires. On the clean `scanned-letter.pdf` fixture it
    #: decided that one line of ordinary Helvetica was upside down, flipped it,
    #: and recognised `Every bounding box is stored in PDF user-space points
    #: with the` as `m sod ds-n ae pos si xo bnoa ass` — which then scored below
    #: `text_score` and was dropped, so the page came back missing a line with a
    #: page confidence of 0.99. A classifier that can only ever be wrong is
    #: worth removing on correctness grounds; that it also removes one of three
    #: ONNX graphs from every page is a bonus.
    #:
    #: `tests/test_ocr_fixtures.py::test_recognised_boxes_cover_the_ink_on_the_page`
    #: is what catches this, by measuring recognised boxes against the ink that
    #: is actually on the page. Nothing else did — the text looked plausible and
    #: the confidence looked excellent.
    classify_orientation: bool = False
    #: Inference threads. Sized by the caller from `WORKER_PARSE_THREADS`, for
    #: the same reason Docling's pool is: oversubscribing the cores makes a
    #: 50-page document slower rather than faster.
    threads: int = 4
    #: An alternative recognition head and its character dictionary, resolved
    #: by :mod:`konusbitr_worker.parse.ocr.languages` from `OCR_MODEL_DIR`.
    #:
    #: `None` is the shipped PP-OCRv4 Chinese/Latin pair, which is the only one
    #: inside the wheel. The Japanese, Korean, Cyrillic and Devanagari heads are
    #: separate downloads, and this module never fetches one — an operator puts
    #: them on disk or the document is routed to Tesseract instead. That is what
    #: keeps `OFFLINE_MODE` a property of the build rather than of the network.
    rec_model_path: str | None = None
    rec_keys_path: str | None = None


class RapidOcrEngine:
    """PP-OCRv4 under `onnxruntime`, loaded once and reused across pages."""

    name = "rapidocr"
    #: The denoised greyscale only. PP-OCRv4 is trained on photographs and reads
    #: a hard black-and-white page slightly *worse* than the original, so there
    #: is nothing for a second pass over the binary to recover.
    preparations = ("image",)

    def __init__(self, options: RapidOcrOptions | None = None) -> None:
        self._options = options or RapidOcrOptions()
        self._engine: Any | None = None
        self._unavailable = False

    def available(self) -> bool:
        return self._load() is not None

    def _load(self) -> Any | None:
        """Build the engine on first use and keep it.

        Lazy for the reason the Docling import is: `onnxruntime` loading three
        ONNX graphs costs a few hundred milliseconds and tens of megabytes, and
        a worker whose documents are all born-digital should never pay it.
        Cached because paying it once per *page* would dominate the OCR budget.
        """
        if self._engine is not None:
            return self._engine
        if self._unavailable:
            return None

        try:
            from rapidocr_onnxruntime import RapidOCR
        except ImportError:
            logger.warning("rapidocr-onnxruntime is not installed; the OCR tier is unavailable")
            self._unavailable = True
            return None

        try:
            # The spellings are RapidOCR's own: a kwarg prefixed `det_` is
            # routed into the detector's config section with the prefix
            # stripped, and an unprefixed one lands in `Global`. A name that
            # does not match a key in `config.yaml` is accepted and silently
            # ignored, so these are pinned by `tests/test_ocr_engines.py`
            # against the shipped config rather than trusted.
            kwargs: dict[str, Any] = {
                "text_score": self._options.text_score,
                "max_side_len": self._options.max_side_length,
                "use_cls": self._options.classify_orientation,
                "det_box_thresh": self._options.box_threshold,
                "det_unclip_ratio": self._options.unclip_ratio,
                "intra_op_num_threads": self._options.threads,
            }
            # Both or neither. A recognition head and its character dictionary
            # are one artifact in two files: loading v4 Japanese weights against
            # the shipped Chinese dictionary decodes every CTC index to the
            # wrong glyph, and does it silently and confidently.
            if self._options.rec_model_path and self._options.rec_keys_path:
                kwargs["rec_model_path"] = self._options.rec_model_path
                kwargs["rec_keys_path"] = self._options.rec_keys_path

            self._engine = RapidOCR(**kwargs)
        except Exception:
            logger.exception("could not initialise RapidOCR")
            self._unavailable = True
            return None
        return self._engine

    def run(self, image: Any) -> OcrResult:
        engine = self._load()
        if engine is None:
            return OcrResult(engine=self.name)

        try:
            output, _elapsed = engine(image)
        except Exception:
            # A recogniser that throws on one page is not a reason to fail a
            # document. The page comes back empty, its confidence is 0.0, and
            # the fallback is tried — which is exactly the path a page it
            # cannot read should take.
            logger.warning("RapidOCR failed on a page", exc_info=True)
            return OcrResult(engine=self.name)

        words: list[OcrWord] = []
        for entry in output or []:
            word = _rapid_word(entry)
            if word is not None:
                words.append(word)
        return OcrResult(words=words, engine=self.name)


def _rapid_word(entry: Any) -> OcrWord | None:
    """One `[polygon, text, score]` row, as the axis-aligned box that holds it.

    PP-OCR detects quadrilaterals, which is how it copes with text that is not
    quite horizontal. The artifact stores rectangles, so the enclosing rectangle
    is what is kept — and the deskew pass upstream is what keeps that rectangle
    close to the ink rather than a loose diamond around it.
    """
    try:
        polygon, text, score = entry[0], entry[1], entry[2]
    except (IndexError, TypeError):
        return None

    text = str(text or "").strip()
    if not text:
        return None

    try:
        xs = [float(point[0]) for point in polygon]
        ys = [float(point[1]) for point in polygon]
    except (TypeError, ValueError, IndexError):
        return None
    if not xs or not ys:
        return None

    try:
        confidence = float(score)
    except (TypeError, ValueError):
        confidence = 0.0

    return OcrWord(
        text=text,
        box=(min(xs), min(ys), max(xs), max(ys)),
        confidence=min(max(confidence, 0.0), 1.0),
    )


# ── Tesseract ────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class TesseractOptions:
    """Tesseract's page-segmentation and engine modes, plus the language set."""

    #: Traineddata names joined with `+`, e.g. `eng` or `tur+eng`.
    #:
    #: Resolved per document since Phase 12.2, by
    #: :func:`konusbitr_worker.parse.ocr.languages.plan_languages`, from
    #: `settings.langList` or from what the identifier made of the document's
    #: text. `OCR_LANGUAGES` is the floor under both.
    languages: str = "eng"
    #: `--psm 3`: fully automatic page segmentation with no orientation
    #: detection. Orientation is the PDF's `/Rotate`, which PDFium applied
    #: before the bitmap existed, so asking Tesseract to detect it again is an
    #: opportunity to disagree with the page row.
    page_segmentation_mode: int = 3
    #: `--oem 3`: the LSTM engine, with the legacy one available where the
    #: traineddata still carries it.
    engine_mode: int = 3
    #: Per-page deadline. Tesseract on a noisy full-page photograph can run for
    #: minutes, and a job timeout is a blunter instrument than a page timeout.
    timeout_seconds: int = 120


class TesseractEngine:
    """Tesseract 5 through `pytesseract`, on the binarised page."""

    name = "tesseract"
    #: Both, in this order, and the reason is measured rather than assumed.
    #:
    #: Tesseract binarises internally and does better on a page somebody else
    #: thresholded well — on the skewed, unevenly lit `scanned-skewed-photo.pdf`
    #: fixture it reads seventy-five words off the Sauvola output and *none at
    #: all* off the denoised greyscale, which is the whole reason the
    #: binarisation exists. But Sauvola's window erodes hairline strokes, and on
    #: the Arabic fixture the binary costs a whole line of connected script that
    #: the greyscale returns cleanly, at an identical page confidence — so
    #: neither the confidence nor a threshold would have caught it.
    #:
    #: Neither preparation dominates, so both are read and the better reading is
    #: kept. It costs about a second a page, on a path that is already the slow
    #: one, and it is the only thing that gets both fixtures right.
    preparations = ("binary", "image")

    def __init__(self, options: TesseractOptions | None = None) -> None:
        self._options = options or TesseractOptions()
        self._available: bool | None = None

    def available(self) -> bool:
        """Whether the `tesseract` binary is installed and answers.

        Cached after the first call: this is a subprocess, and asking once per
        page of a scanned document would be a measurable share of the budget.
        """
        if self._available is not None:
            return self._available

        try:
            import pytesseract
        except ImportError:
            self._available = False
            return False

        try:
            pytesseract.get_tesseract_version()
        except Exception:
            logger.info(
                "tesseract is not installed; OCR runs with the primary engine alone",
            )
            self._available = False
            return False

        self._available = True
        return True

    def run(self, image: Any) -> OcrResult:
        if not self.available():
            return OcrResult(engine=self.name)

        import pytesseract
        from pytesseract import Output

        config = f"--oem {self._options.engine_mode} --psm {self._options.page_segmentation_mode}"
        try:
            data = pytesseract.image_to_data(
                image,
                lang=self._options.languages,
                config=config,
                output_type=Output.DICT,
                timeout=self._options.timeout_seconds,
            )
        except Exception:
            logger.warning("tesseract failed on a page", exc_info=True)
            return OcrResult(engine=self.name)

        return OcrResult(words=list(_tesseract_words(data)), engine=self.name)


def _tesseract_words(data: dict[str, Any]) -> list[OcrWord]:
    """`image_to_data`'s parallel arrays, as words.

    Rows whose confidence is `-1` are the structural levels — page, block,
    paragraph, line — that Tesseract interleaves with the words, and they carry
    no text. Dropping them here is what keeps a page's confidence a statement
    about its words.
    """
    words: list[OcrWord] = []
    texts = data.get("text") or []
    for index, raw_text in enumerate(texts):
        text = str(raw_text or "").strip()
        if not text:
            continue
        try:
            confidence = float(data["conf"][index])
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if confidence < 0:
            continue
        try:
            left = float(data["left"][index])
            top = float(data["top"][index])
            width = float(data["width"][index])
            height = float(data["height"][index])
        except (KeyError, IndexError, TypeError, ValueError):
            continue

        words.append(
            OcrWord(
                text=text,
                box=(left, top, left + width, top + height),
                # Tesseract reports 0-100; every other confidence in this
                # codebase is a fraction, and two scales in one column is how a
                # threshold ends up comparing 71 against 0.65.
                confidence=min(max(confidence / 100.0, 0.0), 1.0),
            )
        )
    return words
