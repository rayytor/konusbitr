"""Hybrid reconciliation: the VLM's structure, the text layer's characters.

A vision model and a text layer are each authoritative about a different half of
a page, and this module is where that division is enforced.

**The VLM owns structure.** Which blocks exist, what kind each one is, where it
sits, and — the thing nothing else in this pipeline can supply — the order a
person reads them in. A two-column newsletter with a sidebar has exactly one
correct sequence and no coordinate sort recovers it.

**The text layer owns characters.** A model asked to transcribe `1,284,567`
returns `1,234,567` and is completely confident. It will do the same to a date,
a case number, a party's name and a dosage. When the page has a font, those
characters are not a matter of opinion, and the *Exact String Invariant* is that
the verbatim sequence from the text layer wins inside any box the VLM drew.

The alignment is a token-level diff rather than a wholesale replacement, and the
difference shows up in exactly one place: a **table**, where the VLM's grid is
the structure and swapping the text wholesale would dissolve the rows back into
prose. So prose takes the truth outright and a table takes it cell by cell. See
:func:`reconcile_element`.

Three counts come out of every element and they are the health metric this
module exists to expose:

- `matched` — tokens the two sources agreed on.
- `substituted` — tokens where the text layer overrode the model. **This is the
  hallucination count**, and on a born-digital page it should be small and
  nonzero: zero usually means the box missed the block rather than that the
  model was perfect.
- `ungrounded` — tokens the model reported that no character in the box
  supports. Dropped from prose, kept and flagged in a table.

A page with no text layer and no confident recognition reconciles against
nothing, and that is a supported state: the elements come back `grounded=False`,
which is the honest statement that what they say is the model's word alone.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, field
from difflib import SequenceMatcher

from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.artifact import ElementType, TableData, markdown_table
from konusbitr_worker.parse.textlayer import TextWord, words_in
from konusbitr_worker.parse.vlm.response import VlmElement

__all__ = [
    "GROUNDING_FLOOR",
    "HIGH_CONFIDENCE_OCR_WORD",
    "ReconciliationReport",
    "normalize_token",
    "reconcile_element",
    "reconcile_page",
]

logger = get_logger("konusbitr.worker.parse.vlm.reconcile")

#: How much the two sources must *agree* before the text layer is trusted to
#: replace a block. See :func:`_is_grounded` for how it is measured.
#:
#: Below it, the box is the thing that is wrong rather than the text: it has
#: landed on the wrong column, or half on a neighbouring block, and the words it
#: contains are not the words the model was describing. Replacing then would
#: substitute one real passage for another real passage, which is a worse error
#: than an unreconciled one — and a far harder one to notice, because both
#: readings are fluent.
#:
#: 0.5 rather than something stricter because the disagreements this tier is for
#: are *dense*: a badly-read page can differ from its text layer in a quarter of
#: its tokens and still be the same passage.
GROUNDING_FLOOR = 0.5

#: Per-word recognition confidence at which an OCR token may be used as *truth*
#: to correct a vision model against.
#:
#: High, and much higher than anything else in the OCR tier, because the roles
#: are reversed here. Elsewhere a 0.7 word is a word worth keeping; here it is a
#: word that would be used to overwrite a different reading of the same ink, and
#: correcting a model's guess with a recogniser's guess produces a confident
#: wrong answer out of two uncertain ones. Below this the page reconciles
#: against fewer tokens, which is the honest outcome.
HIGH_CONFIDENCE_OCR_WORD = 0.9

#: Characters stripped before two tokens are compared.
#:
#: Comparison only — the substituted token is always the text layer's verbatim
#: string, punctuation and all. What this removes is the noise that makes two
#: spellings of the same token compare unequal and so look like a hallucination:
#: a trailing comma the model dropped, a curly quote it straightened.
_PUNCTUATION = re.compile(r"[^\w\s]", re.UNICODE)


@dataclass(slots=True)
class ReconciliationReport:
    """What happened to one element, or summed over a page or a document."""

    elements: int = 0
    #: Elements whose characters are backed by a text layer.
    grounded: int = 0
    matched: int = 0
    substituted: int = 0
    ungrounded: int = 0
    #: Text-layer tokens the model did not report at all. Recovered in prose;
    #: in a table they would break the grid, so they are counted and left out.
    missing: int = 0

    def add(self, other: ReconciliationReport) -> None:
        self.elements += other.elements
        self.grounded += other.grounded
        self.matched += other.matched
        self.substituted += other.substituted
        self.ungrounded += other.ungrounded
        self.missing += other.missing

    @property
    def identity(self) -> float:
        """Fraction of grounded tokens that needed no correction.

        The acceptance criterion reads the *other* way round — every number in
        the reconciled artifact matches the text layer verbatim, which is true
        by construction once a token has been substituted. This is the measure
        of how much work that invariant did, and so of how much a reader would
        have lost without it.
        """
        total = self.matched + self.substituted
        return 1.0 if total == 0 else self.matched / total

    def to_json(self) -> dict[str, int | float]:
        return {
            "elements": self.elements,
            "grounded": self.grounded,
            "matched": self.matched,
            "substituted": self.substituted,
            "ungrounded": self.ungrounded,
            "missing": self.missing,
            "identity": round(self.identity, 4),
        }


def normalize_token(token: str) -> str:
    """The form two tokens are compared in.

    Case-folded, NFKC-normalized, stripped of punctuation. NFKC is the one that
    earns its place: a text layer writes a ligature as `U+FB01` and a model
    writes `fi`, a typesetter writes a non-breaking thousands separator and a
    model writes a comma, and neither difference is a hallucination. Comparing
    the composed forms stops the substitution machinery from "correcting"
    thousands of tokens that were already right.
    """
    folded = unicodedata.normalize("NFKC", token).casefold()
    return _PUNCTUATION.sub("", folded).strip()


def reconcile_page(
    elements: Sequence[VlmElement],
    truth: Sequence[TextWord],
) -> ReconciliationReport:
    """Reconcile every element on one page in place. Returns the page's totals."""
    total = ReconciliationReport()
    for element in elements:
        total.add(reconcile_element(element, truth))
    return total


def reconcile_element(element: VlmElement, truth: Sequence[TextWord]) -> ReconciliationReport:
    """Correct one element's characters against the text layer, in place.

    A figure is left alone deliberately. Its `text` is a description of a
    picture, which is the one thing on a page that has no characters to be
    authoritative about — reconciling it against whatever axis labels happen to
    fall inside its box would replace a sentence about a chart with a list of
    numbers from it.
    """
    report = ReconciliationReport(elements=1)
    if element.type is ElementType.figure:
        return report

    inside = words_in(truth, element.bbox)
    if not inside:
        # No text layer under this block. Ordinary on a scan, and on a figure's
        # caption drawn as part of the image. The model's reading stands and
        # says so.
        element.grounded = False
        element.reconciliation = {"matched": 0, "substituted": 0, "ungrounded": 0, "missing": 0}
        return report

    truth_tokens = [word.text for word in inside]

    if element.type is ElementType.table and element.table is not None:
        counts = _reconcile_table(element, truth_tokens)
    else:
        counts = _reconcile_prose(element, truth_tokens)

    element.reconciliation = counts
    report.matched = counts["matched"]
    report.substituted = counts["substituted"]
    report.ungrounded = counts["ungrounded"]
    report.missing = counts["missing"]
    if element.grounded:
        report.grounded = 1
    return report


# ─── Prose ───────────────────────────────────────────────────────────────────


def _is_grounded(matched: int, vlm_tokens: int, truth_tokens: int) -> bool:
    """Whether the model and the page are describing the same passage.

    Measured on **agreement alone** — the tokens the two sources spelled the
    same way — and not on how many tokens an alignment managed to pair up. That
    distinction is the whole of this function, and getting it wrong is subtle:
    two entirely unrelated token sequences of similar length align into one big
    `replace` opcode, whose tokens pair off perfectly and mean nothing. A
    grounding test built on that number reports a box that landed on the wrong
    column as a confident match, and then overwrites one real paragraph with
    another.

    The measure is the better of two ratios, because the two failure modes it
    has to tolerate pull in opposite directions:

    - **The model invented a sentence.** Its tokens outnumber the page's, so
      agreement over *its* tokens is low — but agreement over the *page's* is
      near total, and the page is what we are about to substitute in.
    - **The model skipped a line.** The mirror image: agreement over the page's
      tokens is low, over the model's it is total.

    A box on the wrong block is the one case where both are near zero, which is
    exactly the case that must not ground.
    """
    if vlm_tokens == 0 or truth_tokens == 0:
        return False
    precision = matched / vlm_tokens
    recall = matched / truth_tokens
    return max(precision, recall) >= GROUNDING_FLOOR


def _reconcile_prose(element: VlmElement, truth_tokens: list[str]) -> dict[str, int]:
    """Replace a prose block's characters with the text layer's, outright.

    Outright rather than token by token, once the alignment has shown the two
    sources are describing the same passage. The text layer's tokens *are* the
    block — in the box, in the order the characters were drawn — so the strongest
    available reading of the Exact String Invariant is simply to take them. It
    also recovers what the model dropped: a line it skipped, a footnote marker it
    swallowed, a word that fell off the end of its transcription.

    Below :data:`GROUNDING_FLOOR` the alignment is saying the box is wrong, and
    the model's own text is kept rather than replaced with a neighbouring
    block's.
    """
    vlm_tokens = element.text.split()
    stats, _ = _align(vlm_tokens, truth_tokens)

    if not _is_grounded(stats["matched"], len(vlm_tokens), len(truth_tokens)):
        element.grounded = False
        return stats

    element.grounded = True
    element.text = " ".join(truth_tokens)
    element.markdown = _markdown_for(element)
    return stats


def _markdown_for(element: VlmElement) -> str:
    """Rebuild a prose element's markdown around its corrected text.

    The markdown of a heading, a list item or a paragraph is a function of its
    type and its text, so it is regenerated rather than patched — the same rule
    the Docling and OCR tiers follow, which is what keeps one document's
    markdown consistent across three parsers.
    """
    text = element.text
    if not text:
        return ""
    if element.type is ElementType.heading:
        return f"{'#' * (element.level or 2)} {text}".rstrip()
    if element.type is ElementType.list:
        return f"- {text}"
    return text


# ─── Tables ──────────────────────────────────────────────────────────────────


def _reconcile_table(element: VlmElement, truth_tokens: list[str]) -> dict[str, int]:
    """Correct a table's cells in place, keeping the model's grid intact.

    The grid is the structure and the structure is the VLM's contribution, so
    the substitution is positional: every cell keeps its place, and the tokens
    inside it are replaced one for one where the alignment found a counterpart.

    Two asymmetries follow from that and neither is avoidable. A token the model
    reported that the page does not contain is **kept**, because deleting it
    would shorten a cell that a header names — it is counted as `ungrounded`
    instead. A token on the page that the model did not report is **not
    inserted**, because there is no cell to insert it into without guessing; it
    is counted as `missing`. Both counts are the honest measure of how well the
    model read the grid, and a table with a large `missing` is one a reader
    should be looking at rather than trusting.
    """
    table = element.table
    if table is None:  # pragma: no cover - guarded by the caller
        return {"matched": 0, "substituted": 0, "ungrounded": 0, "missing": 0}

    cells = [table.headers, *table.rows] if table.headers else list(table.rows)
    # Flattened with a back-reference, so a substitution can be written into the
    # cell it came from without re-deriving which one that was.
    flat: list[str] = []
    origin: list[tuple[int, int, int]] = []
    for row_index, row in enumerate(cells):
        for col_index, cell in enumerate(row):
            for position, token in enumerate(cell.split()):
                flat.append(token)
                origin.append((row_index, col_index, position))

    stats, replacements = _align(flat, truth_tokens)

    if not _is_grounded(stats["matched"], len(flat), len(truth_tokens)):
        element.grounded = False
        return stats

    # Rebuilt cell by cell so a multi-token cell reassembles in its own order.
    rebuilt: dict[tuple[int, int], list[str]] = {}
    for index, token in enumerate(flat):
        row_index, col_index, _ = origin[index]
        rebuilt.setdefault((row_index, col_index), []).append(replacements[index] or token)

    for (row_index, col_index), tokens in rebuilt.items():
        cells[row_index][col_index] = " ".join(tokens)

    headers = cells[0] if table.headers else []
    rows = cells[1:] if table.headers else cells
    element.table = TableData(headers=headers, rows=rows, cells=[])
    element.markdown = markdown_table(headers, rows) or element.markdown
    element.text = element.markdown
    element.grounded = True
    return stats


# ─── Alignment ───────────────────────────────────────────────────────────────


@dataclass(slots=True)
class _Alignment:
    """Per-VLM-token verdict, plus the tokens the page had and the model missed."""

    replacements: list[str | None] = field(default_factory=list)
    matched: int = 0
    substituted: int = 0
    ungrounded: int = 0
    missing: int = 0


def _align(
    vlm_tokens: Sequence[str], truth_tokens: Sequence[str]
) -> tuple[dict[str, int], list[str | None]]:
    """Diff two token sequences and decide what each VLM token should say.

    `difflib.SequenceMatcher` over the *normalized* forms, so that the opcodes
    describe genuine disagreements rather than ligature and punctuation noise.
    The replacement written back is always the **raw** text-layer token: the
    normalization exists to find the correspondence, never to become the output.

    A `replace` opcode covering the same number of tokens on both sides is the
    case this whole module exists for — one token in, one token out, a
    misread digit corrected in place. An unequal `replace` is a genuine
    divergence: the VLM tokens in it are marked ungrounded and the text-layer
    tokens are distributed across them so a prose block still recovers every
    character, which is what `_reconcile_prose` then relies on.

    Returns the counts and, alongside them, what each VLM token should be
    replaced by — `None` for one the text layer had nothing to say about. Prose
    ignores that list and takes the text layer wholesale; a table applies it
    position by position, which is the only way to keep a grid.
    """
    alignment = _Alignment(replacements=[None] * len(vlm_tokens))

    left = [normalize_token(token) for token in vlm_tokens]
    right = [normalize_token(token) for token in truth_tokens]

    # `autojunk` off: it drops tokens appearing in more than 1% of a long
    # sequence, which on a page of prose is every occurrence of "the" — exactly
    # the anchors an alignment needs most.
    matcher = SequenceMatcher(a=left, b=right, autojunk=False)

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for offset in range(i2 - i1):
                alignment.replacements[i1 + offset] = truth_tokens[j1 + offset]
            alignment.matched += i2 - i1
        elif tag == "replace":
            span = i2 - i1
            source = j2 - j1
            if span == source:
                for offset in range(span):
                    alignment.replacements[i1 + offset] = truth_tokens[j1 + offset]
                alignment.substituted += span
            else:
                # Unequal. Pair off what can be paired, and account for the rest
                # honestly on whichever side has the surplus.
                paired = min(span, source)
                for offset in range(paired):
                    alignment.replacements[i1 + offset] = truth_tokens[j1 + offset]
                alignment.substituted += paired
                alignment.ungrounded += max(0, span - source)
                alignment.missing += max(0, source - span)
        elif tag == "delete":
            # The model reported tokens no character in the box supports.
            alignment.ungrounded += i2 - i1
        elif tag == "insert":
            alignment.missing += j2 - j1

    return (
        {
            "matched": alignment.matched,
            "substituted": alignment.substituted,
            "ungrounded": alignment.ungrounded,
            "missing": alignment.missing,
        },
        alignment.replacements,
    )
