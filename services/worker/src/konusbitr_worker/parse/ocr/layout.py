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

This is deliberately geometric and deliberately modest. It is not a layout
model: it does not find headings, it does not find tables, and it does not try
to. Scanned-table reconstruction is Phase 12.2 and a VLM reading of the page is
Phase 12.3. What it does do is produce paragraph-shaped elements in reading
order with boxes that enclose their own text, which is what the chunker needs
and what a citation can point at.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from konusbitr_worker.parse.ocr.engines import OcrWord

__all__ = ["OcrBlock", "OcrLine", "group_blocks", "group_lines"]

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


@dataclass(slots=True)
class OcrLine:
    """One line of recognised text, with the words that make it up."""

    words: list[OcrWord] = field(default_factory=list)

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


def group_lines(words: list[OcrWord]) -> list[OcrLine]:
    """Assemble words into lines, top to bottom and then left to right."""
    ordered = sorted(words, key=lambda word: (word.box[1], word.box[0]))

    lines: list[OcrLine] = []
    for word in ordered:
        target = _line_for(lines, word)
        if target is None:
            lines.append(OcrLine(words=[word]))
        else:
            target.words.append(word)

    for line in lines:
        line.words.sort(key=lambda word: word.box[0])

    split = [piece for line in lines for piece in _split_at_gutters(line)]

    # Re-sorted after assembly rather than relying on insertion order: a line
    # whose first word was detected below a neighbouring line's first word
    # would otherwise be emitted out of reading order.
    split.sort(key=lambda line: (line.box[1], line.box[0]))
    return split


def _split_at_gutters(line: OcrLine) -> list[OcrLine]:
    """Break one assembled line wherever the horizontal gap is gutter-sized.

    Measured against the line's own height, so the same rule holds for a 6pt
    footnote and a 28pt heading. A line with one word has no gaps and comes back
    unchanged, which is the overwhelmingly common case and costs one comparison.
    """
    if len(line.words) < 2:
        return [line]

    threshold = max(line.height, 1.0) * GUTTER_GAP_RATIO
    pieces: list[OcrLine] = []
    current = [line.words[0]]

    for previous, word in zip(line.words, line.words[1:], strict=False):
        if word.box[0] - previous.box[2] > threshold:
            pieces.append(OcrLine(words=current))
            current = [word]
        else:
            current.append(word)

    pieces.append(OcrLine(words=current))
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


def group_blocks(lines: list[OcrLine]) -> list[OcrBlock]:
    """Assemble lines into paragraph-shaped blocks, in reading order."""
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

    # By where each block *starts*, left to right on a tie — so a two-column
    # page reads down the left column and then down the right, rather than
    # alternating between them line by line.
    blocks.sort(key=lambda block: (block.box[1], block.box[0]))
    return blocks


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
