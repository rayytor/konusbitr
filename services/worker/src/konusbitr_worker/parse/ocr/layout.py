"""Turning a bag of word boxes into lines, and lines into paragraphs.

An OCR engine returns tokens with no structure: no reading order, no line
breaks, no paragraphs. Handing those straight to the chunker would produce
passages whose text is a column of words read across two columns of a page —
individually plausible, collectively nonsense, and impossible to notice from
the markdown alone.

So the geometry is used to rebuild what the recogniser discarded, in two passes
with one idea behind each:

**Words into lines.** Two words are on the same line when their boxes overlap
vertically by more than half the shorter one's height. A fraction rather than a
pixel tolerance, because the same document contains 8pt footnotes and 24pt
headings and any absolute threshold is wrong for one of them.

That rule alone is not enough, and the case it gets wrong is the important one:
on a two-column page the first line of the left column and the first line of the
right column overlap vertically *completely*, so they are assembled into one
line that reads "left right column column". So an assembled line is then **split
at any horizontal gap wider than** :data:`GUTTER_GAP_RATIO` **of its own
height** — which is what a gutter is, and what an inter-word space never is.

**Lines into blocks.** A line joins an *open* block when it is close enough
vertically — within :data:`PARAGRAPH_GAP_RATIO` of the line height — and their
horizontal spans overlap.

"Open block" rather than "the previous block", and that is the second thing the
two-column case forces. Lines arrive sorted top to bottom, so on a two-column
page they arrive alternating between the columns, and a pass that only ever
considers the block it is currently building starts a new one on every single
line. Each line is therefore offered to the last few open blocks and joins the
nearest one that fits, which lets two columns accumulate side by side.

Blocks come back ordered by where they *start*, so the left column — whose first
line is level with the right column's first line and to the left of it — is
emitted first, whole, before the right. That is the reading order a person uses.

**Reading order runs the other way for Arabic and Hebrew**, and Phase 12.2 is
where that is honoured. Everything above is about geometry and is unchanged by
it; what changes is the direction "next" means. Words on a line are ordered by
decreasing x, a line is split at a gutter by walking the same way, and blocks
are emitted starting from the right-hand column. Getting this wrong does not
produce garbage — it produces a sentence with its words in reverse, which reads
as a recognition failure, embeds as nonsense, and can never be matched by the
quote verifier against anything a model quotes back.

Tesseract already returns Arabic words in logical order; the reason this matters
is that the grouping below *re-sorts* them, and a re-sort by ascending x undoes
exactly the work the engine's own bidirectional handling did.

**Direction is decided per line, from the line's own characters**, not once for
the document. The obvious alternative — take it from the language routing — was
tried and is wrong in the case that actually occurs: an Arabic filing with an
English cover page, or a Turkish contract with an Arabic appendix, is one
document with pages of both directions, and a document-level flag reverses every
word on the pages it gets wrong. The language plan is still consulted, as the
tiebreak for a line that contains no letters at all — a row of figures inside an
Arabic table belongs to that table's direction and has nothing of its own to
say.

This is deliberately geometric and deliberately modest. It is not a layout
model: it does not find headings, and it finds tables only by the ruling lines
around them — :mod:`konusbitr_worker.parse.ocr.tables` owns that and is handed
the words this module would otherwise group into prose. A VLM reading of the
page is Phase 12.3. What it does do is produce paragraph-shaped elements in
reading order with boxes that enclose their own text, which is what the chunker
needs and what a citation can point at.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from konusbitr_worker.parse.ocr.engines import OcrWord

__all__ = ["OcrBlock", "OcrLine", "group_blocks", "group_lines", "is_rtl_text"]

#: Unicode blocks written right to left. Coarse, and it only has to be: the
#: question is which end of a line a reader starts at, and that has two answers.
_RTL_RANGES: tuple[tuple[int, int], ...] = (
    (0x0590, 0x05FF),  # Hebrew
    (0x0600, 0x06FF),  # Arabic
    (0x0700, 0x074F),  # Syriac
    (0x0750, 0x077F),  # Arabic Supplement
    (0x0780, 0x07BF),  # Thaana
    (0x07C0, 0x07FF),  # NKo
    (0x08A0, 0x08FF),  # Arabic Extended-A
    (0xFB1D, 0xFDFF),  # Hebrew and Arabic presentation forms
    (0xFE70, 0xFEFF),  # Arabic Presentation Forms-B
)

#: Vertical overlap, as a fraction of the shorter box's height, at which two
#: words are taken to be on one line.
LINE_OVERLAP_RATIO = 0.5

#: Vertical gap between baselines, as a multiple of line height, past which a
#: new paragraph starts. 1.6 sits between ordinary leading (about 1.2) and the
#: space a typesetter puts between paragraphs.
PARAGRAPH_GAP_RATIO = 1.6

#: Horizontal overlap two lines need to belong to the same block, as a fraction
#: of the narrower line's width. Low, because a paragraph's last line is short
#: and an indented first line starts late — both must still join the block above.
BLOCK_OVERLAP_RATIO = 0.15

#: Horizontal gap, as a multiple of line height, at which one assembled line is
#: split into two.
#:
#: An inter-word space runs to about a quarter of the line height and the space
#: after a full stop to about a third; a two-column gutter is upwards of one and
#: a half, and the gap between a label and a right-aligned figure is wider still.
#: 1.5 sits in the empty band between those two populations.
#:
#: How much this rule does depends on the engine, which is worth knowing before
#: tuning it. PP-OCR detects whole text *regions*, so its boxes rarely straddle
#: a gutter and this mostly does nothing. Tesseract reports individual words,
#: and on a two-column page this is the only thing standing between a reader and
#: prose that was never written.
GUTTER_GAP_RATIO = 1.5


def is_rtl_text(text: str, *, default: bool = False) -> bool:
    """Whether a run of text reads right to left.

    A majority vote over the letters rather than Unicode's own first-strong
    rule, and the difference matters here. First-strong reads a *storage* order,
    and the storage order of a recognised line is whatever the engine emitted —
    which for a line assembled out of separate word boxes is not a property of
    the page at all. A majority is a property of the text, and it gives the
    right answer for the mixed line that actually occurs: an Arabic sentence
    naming an English product is Arabic, and an English sentence quoting one
    Hebrew word is English.

    `default` is returned for a run with no letters in it — a row of figures, a
    page number — which has no direction of its own and takes the document's.
    """
    rtl = 0
    ltr = 0
    for character in text:
        if not character.isalpha():
            continue
        if _is_rtl_char(ord(character)):
            rtl += 1
        else:
            ltr += 1
    if rtl == 0 and ltr == 0:
        return default
    return rtl > ltr


def _is_rtl_char(codepoint: int) -> bool:
    return any(start <= codepoint <= end for start, end in _RTL_RANGES)


@dataclass(slots=True)
class OcrLine:
    """One line of recognised text, with the words that make it up.

    `words` is held in **logical** order — the order a reader reads them — which
    for a right-to-left line means descending x. Geometry that needs the visual
    order derives it; nothing needs it often enough to store twice.
    """

    words: list[OcrWord] = field(default_factory=list)
    #: True when this line reads right to left. Decided from the line's own
    #: characters by :func:`is_rtl_text`, with the document's language plan as
    #: the tiebreak for a line that contains none.
    rtl: bool = False

    @property
    def text(self) -> str:
        return " ".join(word.text for word in self.words if word.text)

    @property
    def box(self) -> tuple[float, float, float, float]:
        return _enclosing(word.box for word in self.words)

    @property
    def height(self) -> float:
        box = self.box
        return box[3] - box[1]


@dataclass(slots=True)
class OcrBlock:
    """A paragraph-shaped run of lines."""

    lines: list[OcrLine] = field(default_factory=list)

    @property
    def text(self) -> str:
        """The block's lines joined, de-hyphenating across the break.

        A word split by a line break is one word, and leaving it as `photo-` and
        `graphic` costs a retrieval hit and a citation: the quote verifier looks
        for the phrase the model quoted in the page's text, and the page's text
        would not contain it. Joined only when the next line starts lowercase,
        so a genuine hyphenated compound at a line end — `state-` / `Level` — is
        left alone.
        """
        parts: list[str] = []
        for line in self.lines:
            text = line.text
            if parts and parts[-1].endswith("-"):
                stripped = parts[-1][:-1]
                if text[:1].islower():
                    parts[-1] = stripped + text
                    continue
            parts.append(text)
        return " ".join(part for part in parts if part).strip()

    @property
    def box(self) -> tuple[float, float, float, float]:
        return _enclosing(line.box for line in self.lines)

    @property
    def words(self) -> list[OcrWord]:
        return [word for line in self.lines for word in line.words]

    @property
    def confidence(self) -> float:
        """Length-weighted, on the same basis as a page's."""
        total = 0.0
        weight = 0.0
        for word in self.words:
            length = float(len(word.text.strip()))
            if length <= 0:
                continue
            total += word.confidence * length
            weight += length
        return total / weight if weight > 0 else 0.0


def group_lines(words: list[OcrWord], *, rtl: bool = False) -> list[OcrLine]:
    """Assemble words into lines, top to bottom and then in reading order.

    `rtl` is the *default* direction, from the document's language plan. Each
    assembled line then decides for itself from its own characters, so a Latin
    page inside an Arabic document is not reversed — see the module docstring.

    Direction reverses only the horizontal half of the assembly: the vertical
    grouping, the gutter rule and the thresholds are identical, because a
    right-to-left page is laid out the same way and read the other way round.
    """
    # Assembled left to right whatever the direction. This ordering only
    # decides which line a word is *offered* to, and `_line_for` searches a
    # window of recent lines, so it has to be consistent rather than correct.
    ordered = sorted(words, key=lambda word: (word.box[1], word.box[0]))

    lines: list[OcrLine] = []
    for word in ordered:
        target = _line_for(lines, word)
        if target is None:
            lines.append(OcrLine(words=[word]))
        else:
            target.words.append(word)

    for line in lines:
        line.rtl = is_rtl_text(" ".join(word.text for word in line.words), default=rtl)
        line.words.sort(key=lambda word: _lead(word.box, line.rtl))

    split = [piece for line in lines for piece in _split_at_gutters(line)]

    # Re-sorted after assembly rather than relying on insertion order: a line
    # whose first word was detected below a neighbouring line's first word
    # would otherwise be emitted out of reading order.
    split.sort(key=lambda line: (line.box[1], _lead(line.box, line.rtl)))
    return split


def _lead(box: tuple[float, float, float, float], rtl: bool) -> float:
    """The horizontal coordinate reading starts from: the left edge, or the right.

    Negated for the right-to-left case so that one ascending sort serves both
    directions, rather than two sorts that could drift apart.
    """
    return -box[2] if rtl else box[0]


def _split_at_gutters(line: OcrLine) -> list[OcrLine]:
    """Break one assembled line wherever the horizontal gap is gutter-sized.

    Measured against the line's own height, so the same rule holds for a 6pt
    footnote and a 28pt heading. A line with one word has no gaps and comes back
    unchanged, which is the overwhelmingly common case and costs one comparison.

    The words are already in logical order, so "the gap before the next word" is
    read in that direction too — on a right-to-left line the next word is to the
    *left*, and measuring the gap the other way would split every line at its
    first space and none at its gutter.
    """
    if len(line.words) < 2:
        return [line]

    threshold = max(line.height, 1.0) * GUTTER_GAP_RATIO
    pieces: list[OcrLine] = []
    current = [line.words[0]]

    for previous, word in zip(line.words, line.words[1:], strict=False):
        gap = previous.box[0] - word.box[2] if line.rtl else word.box[0] - previous.box[2]
        if gap > threshold:
            pieces.append(OcrLine(words=current, rtl=line.rtl))
            current = [word]
        else:
            current.append(word)

    pieces.append(OcrLine(words=current, rtl=line.rtl))
    return pieces


def _line_for(lines: list[OcrLine], word: OcrWord) -> OcrLine | None:
    """The open line this word belongs to, if any.

    Searched from the end because the words arrive top-to-bottom, so the line a
    word joins is almost always the last one opened — and on a page with two
    thousand words, scanning from the front is quadratic.
    """
    for line in reversed(lines[-8:]):
        if _shares_a_line(line.box, word.box):
            return line
    return None


def _shares_a_line(
    left: tuple[float, float, float, float], right: tuple[float, float, float, float]
) -> bool:
    overlap = min(left[3], right[3]) - max(left[1], right[1])
    if overlap <= 0:
        return False
    shorter = min(left[3] - left[1], right[3] - right[1])
    if shorter <= 0:
        return False
    return overlap / shorter >= LINE_OVERLAP_RATIO


#: How many recently-opened blocks a line may join.
#:
#: Bounded so that grouping stays linear in the number of lines rather than
#: quadratic — a dense 300 DPI page runs to a couple of hundred lines and a
#: 500-page scan to a hundred thousand. Four is comfortably more than the number
#: of columns any page has, which is the thing the window has to cover.
_OPEN_BLOCKS = 4


def group_blocks(lines: list[OcrLine], *, rtl: bool = False) -> list[OcrBlock]:
    """Assemble lines into paragraph-shaped blocks, in reading order.

    `rtl` is again the default. The *page's* direction is taken from its lines
    rather than from the plan, because it decides which column of a two-column
    page is read first — and a page is the right granularity for that question
    in a way a document is not.
    """
    page_rtl = _majority_direction(lines, default=rtl)
    blocks: list[OcrBlock] = []
    open_blocks: list[OcrBlock] = []

    for line in lines:
        target = next(
            (block for block in reversed(open_blocks) if _continues(block, line)),
            None,
        )
        if target is None:
            target = OcrBlock(lines=[line])
            blocks.append(target)
            open_blocks.append(target)
            del open_blocks[:-_OPEN_BLOCKS]
        else:
            target.lines.append(line)
            # Moved to the front of the window: the block a line just extended
            # is the likeliest home for the next one.
            open_blocks.remove(target)
            open_blocks.append(target)

    # By where each block *starts* — the left edge on a left-to-right page and
    # the right edge on a right-to-left one — so a two-column page reads down
    # the first column and then down the second, rather than alternating
    # between them line by line.
    blocks.sort(key=lambda block: (block.box[1], _lead(block.box, page_rtl)))
    return blocks


def _majority_direction(lines: list[OcrLine], *, default: bool) -> bool:
    """The direction most of a page's characters read in."""
    rtl = sum(len(line.text) for line in lines if line.rtl)
    ltr = sum(len(line.text) for line in lines if not line.rtl)
    if rtl == 0 and ltr == 0:
        return default
    return rtl > ltr


def _continues(block: OcrBlock, line: OcrLine) -> bool:
    """Whether `line` belongs to the paragraph `block` is building."""
    previous = block.lines[-1]
    gap = line.box[1] - previous.box[3]
    reference = max(previous.height, line.height, 1.0)
    if gap > reference * PARAGRAPH_GAP_RATIO:
        return False
    # A line that starts above the one before it is not the next line of the
    # same paragraph — it is the top of the next column.
    if line.box[1] < previous.box[1]:
        return False

    overlap = min(previous.box[2], line.box[2]) - max(previous.box[0], line.box[0])
    if overlap <= 0:
        return False
    narrower = min(previous.box[2] - previous.box[0], line.box[2] - line.box[0])
    if narrower <= 0:
        return False
    return overlap / narrower >= BLOCK_OVERLAP_RATIO


def _enclosing(boxes) -> tuple[float, float, float, float]:
    collected = list(boxes)
    if not collected:
        return (0.0, 0.0, 0.0, 0.0)
    return (
        min(box[0] for box in collected),
        min(box[1] for box in collected),
        max(box[2] for box in collected),
        max(box[3] for box in collected),
    )
