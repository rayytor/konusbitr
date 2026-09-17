"""The characters a PDF actually contains, with the rectangle each one occupies.

This exists for exactly one consumer: the hybrid reconciliation in
:mod:`konusbitr_worker.parse.vlm.reconcile`. A vision model is good at *where a
block is and what kind of block it is* and unreliable at *which digits are
printed in it* — it will read `1,284,567` as `1,234,567` and be entirely
confident. When the page has a text layer, the digits are not a matter of
opinion: they are in the file, and this module is how they are recovered.

Docling is not the source, for two reasons. It hands back elements, not words,
so a per-token substitution has nothing to align against; and asking it to parse
a page whose structure is about to be replaced by the VLM's is paying a layout
model for an answer that gets discarded. PDFium's text page is the cheap,
direct route to the same characters.

**The coordinate trap is the one `docs/coordinates.md` names.** PDFium reports a
character box in *unrotated page space with a bottom-left origin* — the same
frame `parse/images.py` gets object bounds in, and the opposite of
`parse/ocr/raster.py`, where the renderer had already applied ``/Rotate``. So
the conversion here is ``origin=bottom_left, rotated=False``, which is the call
that runs the rotation table.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.geometry import BBox, CoordOrigin, PageGeometry

__all__ = ["TextWord", "page_words", "words_in"]

logger = get_logger("konusbitr.worker.parse.textlayer")

#: Horizontal gap, as a multiple of a character's **advance** width, that ends a
#: word even without a space character.
#:
#: Typeset PDFs routinely encode inter-word space as a positioning operator
#: rather than as a `U+0020`, so a splitter that trusted whitespace alone would
#: return one token per line on those files. A quarter of an advance is well
#: above the kerning inside a word — which is essentially zero once measured
#: against advances — and well below a word space, which is close to a full one.
_GAP_RATIO = 0.25

#: Vertical movement, as a multiple of the line's height, that ends a word.
#: Catches the line break, and catches a superscript footnote marker sitting
#: flush against the word it annotates.
_LINE_RATIO = 0.5


@dataclass(frozen=True, slots=True)
class TextWord:
    """One whitespace-delimited token from the text layer, in the convention.

    "Word" rather than "character" because that is the unit reconciliation
    aligns on, and because a per-character alignment would spend its time
    deciding that two identical letters in different words correspond.
    """

    text: str
    bbox: BBox


def page_words(
    path: Path,
    pages: Sequence[int],
    *,
    geometries: dict[int, PageGeometry],
) -> dict[int, list[TextWord]]:
    """Extract the text layer of the named pages, as located words.

    Returns a dict rather than a list so a caller can ask about one page without
    knowing where it landed, and so a page with no text layer at all is an empty
    list rather than an absent entry — which is the ordinary case for a scan and
    must not read as an error.

    Synchronous and CPU-bound; the pipeline calls it on a thread.
    """
    import pypdfium2 as pdfium

    if not pages:
        return {}

    words: dict[int, list[TextWord]] = {}
    document = pdfium.PdfDocument(str(path))
    try:
        for page_no in pages:
            geometry = geometries.get(page_no)
            if geometry is None:  # pragma: no cover - the inspection produced these
                continue
            words[page_no] = _words_of(document, page_no, geometry)
    finally:
        document.close()

    return words


def _words_of(document: Any, page_no: int, geometry: PageGeometry) -> list[TextWord]:
    """One page's words. Never raises: a page with no text layer has no words."""
    try:
        page = document[page_no - 1]
    except Exception:  # pragma: no cover - the inspection opened this document
        return []

    try:
        textpage = page.get_textpage()
    except Exception:
        page.close()
        return []

    try:
        return _collect(textpage, geometry)
    except Exception:
        # A malformed text layer is not worth failing a parse over: the VLM's
        # own reading stands, unreconciled and flagged as such, which is exactly
        # what a page with no text layer gets.
        logger.warning("could not read the text layer of a page", extra={"page": page_no})
        return []
    finally:
        textpage.close()
        page.close()


def _collect(textpage: Any, geometry: PageGeometry) -> list[TextWord]:
    """Walk the character array, breaking it into words as the geometry dictates.

    **Two boxes are read per character and they do different jobs.** PDFium's
    *tight* box is the glyph's ink, which is what a highlight should cover; its
    *loose* box is the full font bounds, which is what the word boundaries have
    to be measured against.

    Using the tight box for both is the obvious implementation and it is wrong,
    in both directions. The tight box of an `i` is under a point wide, so the
    ordinary letter spacing after it looks like a word gap and `bounding`
    splits into `boundi` and `ng`; the tight box of an `m` is wider than a
    space, so a real word break after one is missed. Loose boxes are
    contiguous within a word and a full advance apart across a space, which
    makes the same comparison unambiguous — and their height is constant along
    a line, which is what makes the line-break test reliable rather than
    dependent on whether the previous glyph had a descender.
    """
    count = int(textpage.count_chars())
    if count <= 0:
        return []

    words: list[TextWord] = []
    buffer: list[str] = []
    # Accumulated in PDFium's own frame; converted once, when the word closes.
    left = bottom = right = top = 0.0
    previous: tuple[float, float, float, float] | None = None

    def flush() -> None:
        nonlocal buffer, previous
        text = "".join(buffer).strip()
        buffer = []
        previous = None
        if not text:
            return
        bbox = geometry.normalize(
            (left, bottom, right, top),
            origin=CoordOrigin.bottom_left,
            rotated=False,
        )
        if not bbox.is_degenerate:
            words.append(TextWord(text=text, bbox=bbox))

    for index in range(count):
        character = textpage.get_text_range(index, 1)
        if not character or character.isspace():
            flush()
            continue

        boxes = _boxes(textpage, index)
        if boxes is None:
            # A glyph with no box cannot be located, and an unlocatable
            # character in the middle of a word would silently widen the word's
            # rectangle to nothing useful. It still belongs to the word's text.
            if buffer:
                buffer.append(character)
            continue
        tight, loose = boxes

        if previous is not None and _breaks_word(previous, loose):
            flush()

        if not buffer:
            left, bottom, right, top = tight
        else:
            left = min(left, tight[0])
            bottom = min(bottom, tight[1])
            right = max(right, tight[2])
            top = max(top, tight[3])

        buffer.append(character)
        previous = loose

    flush()
    return words


def _boxes(
    textpage: Any, index: int
) -> tuple[tuple[float, float, float, float], tuple[float, float, float, float]] | None:
    """One character's tight (ink) and loose (font bounds) boxes.

    The loose box falls back to the tight one rather than failing: an older
    PDFium, or a glyph whose font bounds cannot be resolved, then measures word
    gaps the imperfect way instead of producing no word at all.
    """
    try:
        tight = tuple(float(value) for value in textpage.get_charbox(index))
    except Exception:
        return None
    try:
        loose = tuple(float(value) for value in textpage.get_charbox(index, loose=True))
    except Exception:
        loose = tight
    return tight, loose  # type: ignore[return-value]


def _breaks_word(
    previous: tuple[float, float, float, float],
    current: tuple[float, float, float, float],
) -> bool:
    """Whether the gap between two adjacent characters ends a word.

    Both arguments are **loose** boxes — see :func:`_collect` for why that is
    load-bearing rather than incidental.

    Two independent tests, because typeset text breaks words two ways. A
    horizontal jump is the space a PDF drew with a positioning operator instead
    of a space character; a vertical jump is the next line, or a superscript.
    """
    prev_left, prev_bottom, prev_right, prev_top = previous
    current_left, current_bottom, _, _ = current

    height = max(prev_top - prev_bottom, 1e-6)
    if abs(current_bottom - prev_bottom) > height * _LINE_RATIO:
        return True

    advance = max(prev_right - prev_left, 1e-6)
    return (current_left - prev_right) > advance * _GAP_RATIO


def words_in(words: Sequence[TextWord], box: BBox, *, tolerance: float = 2.0) -> list[TextWord]:
    """The words whose centre lies inside `box`, in the text layer's own order.

    Centre containment rather than overlap, and the difference matters on a
    two-column page: a word straddling the gutter overlaps both column boxes and
    belongs to exactly one of them. Its centre answers which.

    Order is preserved from the text layer rather than re-sorted by position.
    The text layer's order *is* the order the characters were drawn, which
    within a single block is the order they are read — and a re-sort by
    ``(y, x)`` would scramble any line whose glyphs sit a fraction of a point
    apart vertically, which is every justified line.
    """
    x0 = box.x0 - tolerance
    y0 = box.y0 - tolerance
    x1 = box.x1 + tolerance
    y1 = box.y1 + tolerance

    inside: list[TextWord] = []
    for word in words:
        centre_x = (word.bbox.x0 + word.bbox.x1) / 2
        centre_y = (word.bbox.y0 + word.bbox.y1) / 2
        if x0 <= centre_x <= x1 and y0 <= centre_y <= y1:
            inside.append(word)
    return inside
