"""Layout-aware chunking.

Chunk quality dominates answer quality — more than model choice, more than
prompt wording — and almost every way a chunker can be wrong is a way of losing
something the parse already knew. So this one is built out of the parse
artifact's elements rather than out of its markdown, and it holds five rules.

**A table is never split.** Half a table answers nothing and cites nothing: the
header row and the number land in different chunks, and whichever one is
retrieved is missing the other. An oversized table becomes its own chunk, and is
truncated with an explicit marker only when it will not fit in the embedding
model's context at all.

**A table interrupts a chunk without interrupting the prose.** The table is its
own chunk and the paragraphs either side of it stay in one passage — otherwise a
financial report that alternates a sentence with a table yields nothing but
fragments. Prose and tables are therefore chunked as two streams and merged
back into reading order before ordinals are assigned.

**A heading of level 1 or 2 ends a chunk — once the chunk is worth ending.** A
passage that mixes two top-level sections answers questions about neither, and
the retrieval score it gets is the average of two relevances. But that rule is a
means, not an end, and taken absolutely it fights the band: the fixture corpus
carries a heading on every page, and honouring every one of them produced
255-token fragments from end to end. So a boundary flushes once the chunk has
reached the floor, and adjacent sections merge when the alternative is a
fragment too small to answer anything with. A section larger than the band is
split regardless, because it has to be split somewhere.

**The breadcrumb is part of the text.** `Financials > Revenue` costs a handful of
tokens and measurably improves retrieval, because a paragraph about "the
increase" is about nothing at all once it has left its page.

**Every chunk knows where it came from.** The union of its elements' boxes, one
rectangle per page, so a chunk spanning a page break has an entry for each. This
is the load-bearing one: a passage that cannot say where it came from cannot be
cited, and an uncitable answer is the failure this product exists to prevent.
The overlap is element-level rather than token-level precisely to keep it true —
the tail elements repeated at the head of the next chunk bring their pages with
them, so a quote drawn from the overlap is still inside the chunk's own
rectangles.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from konusbitr_worker.ai.tokens import Tokenizer
from konusbitr_worker.chunk.elements import SourceElement
from konusbitr_worker.log import get_logger

__all__ = [
    "MAX_CHUNK_CONTEXT_TOKENS",
    "SECTION_PATH_SEPARATOR",
    "TRUNCATION_MARKER",
    "Chunk",
    "ChunkingOptions",
    "chunk_elements",
]

logger = get_logger("konusbitr.worker.chunk")

#: The breadcrumb separator, matching `SECTION_PATH_SEPARATOR` in
#: `packages/shared/src/chunk.ts`.
SECTION_PATH_SEPARATOR = " > "

#: Left behind when content had to be dropped. Matches `TRUNCATION_MARKER` in
#: `packages/shared/src/chunk.ts`, and it is in the chunk *text* rather than only
#: in metadata: whatever reads the chunk has to be able to tell that it is
#: looking at part of a table rather than all of one.
TRUNCATION_MARKER = "[... truncated to fit the embedding model context ...]"

#: The ceiling a single chunk may not exceed however atomic its content is.
#:
#: A property of the models rather than of the deployment, which is why it is a
#: constant and not an environment variable: BGE-M3 accepts 8192 tokens and
#: `text-embedding-3-large` 8191, and a request over the limit is rejected
#: outright. 8000 leaves room for the breadcrumb and for a tokenizer that
#: disagrees with ours by a percent.
MAX_CHUNK_CONTEXT_TOKENS = 8000

#: Sentence-ish boundaries, for splitting an element too big to chunk whole.
#:
#: Deliberately crude. A real sentence segmenter is a language-dependent
#: dependency, and what is needed here is only "a place a reader would accept a
#: break": end-of-sentence punctuation followed by whitespace, or a blank line.
#: Below that the fallback is a word boundary, which is always available.
_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?;:])\s+|\n{2,}")


@dataclass(slots=True)
class Chunk:
    """One retrievable passage."""

    #: Position in the document, 0-based. The upsert key, with `document_id`.
    ordinal: int
    #: Where in the element stream this chunk's own content begins. Used only to
    #: restore reading order across the prose and table streams.
    start: int
    #: Breadcrumb plus body — what gets embedded and what a model reads.
    text: str
    token_count: int
    section_path: str | None
    #: One rectangle per page, ascending. Never empty.
    pages: list[dict[str, Any]]
    #: `prose` or `table`. Only prose is held to the token band; a table's size
    #: is the table's, not a choice the chunker made.
    kind: str
    element_ids: list[str]
    truncated: bool = False
    table_json: dict[str, Any] | None = None

    def to_meta(self) -> dict[str, Any]:
        """The sidecar stored in `chunks.meta`."""
        return {
            "kind": self.kind,
            "elementIds": list(self.element_ids),
            "tableJson": self.table_json,
            "truncated": self.truncated,
        }


@dataclass(frozen=True, slots=True)
class ChunkingOptions:
    """The band and the boundary, as configuration hands them over."""

    target_tokens: int = 800
    min_tokens: int = 600
    max_tokens: int = 900
    overlap_ratio: float = 0.15
    #: Headings at or above this level end a chunk. `2` means `#` and `##`.
    boundary_heading_level: int = 2

    @property
    def overlap_tokens(self) -> int:
        return int(self.target_tokens * self.overlap_ratio)


def chunk_elements(
    elements: Sequence[SourceElement],
    *,
    tokenizer: Tokenizer,
    options: ChunkingOptions,
) -> list[Chunk]:
    """Turn a parse artifact's elements into chunks, in reading order."""
    usable = [element for element in elements if element.text.strip() or element.is_table]
    if not usable:
        return []

    chunks = [
        *_table_chunks([e for e in usable if e.is_table], tokenizer=tokenizer),
        *_prose_chunks([e for e in usable if not e.is_table], tokenizer=tokenizer, options=options),
    ]

    # Reading order is restored here rather than preserved throughout, because
    # prose and tables are chunked by different rules over the same stream.
    # Ordinals are assigned last, over the whole document: they are the upsert
    # key, so they must be dense and stable for a given input, and a per-stream
    # counter would collide.
    chunks.sort(key=lambda chunk: chunk.start)
    for ordinal, chunk in enumerate(chunks):
        chunk.ordinal = ordinal
    return chunks


# ── Tables ───────────────────────────────────────────────────────────────────


def _table_chunks(elements: Sequence[SourceElement], *, tokenizer: Tokenizer) -> list[Chunk]:
    """One chunk per table, whatever its size."""
    chunks: list[Chunk] = []
    for element in elements:
        body = element.markdown or element.text
        if not body.strip():
            # A table the parser located but could not read anything out of. A
            # chunk of it would have no text to embed and nothing to retrieve
            # on, so it is dropped rather than stored as an empty passage.
            logger.warning("a table had no readable content", extra={"element": element.id})
            continue

        breadcrumb = _breadcrumb(element.section_path)
        truncated = False

        budget = MAX_CHUNK_CONTEXT_TOKENS - tokenizer.count(breadcrumb or "")
        if tokenizer.count(body) > budget:
            # The only case a table is cut, and it is cut visibly. A table this
            # large is beyond what any embedding model will accept, so the
            # alternative is not "a whole table" but "no chunk at all".
            # The marker is counted *with* its separator: a newline is a token
            # of its own to a byte-pair encoder, and budgeting for the marker
            # alone put the result one token over the limit.
            suffix = f"\n{TRUNCATION_MARKER}"
            body = tokenizer.truncate(body, budget - tokenizer.count(suffix)) + suffix
            truncated = True
            logger.warning(
                "a table was truncated to fit the embedding context",
                extra={"element": element.id, "page": element.page},
            )

        text = _compose(breadcrumb, body)
        chunks.append(
            Chunk(
                ordinal=0,
                start=element.order,
                text=text,
                token_count=tokenizer.count(text),
                section_path=breadcrumb,
                pages=_union_pages([element]),
                kind="table",
                element_ids=[element.id],
                truncated=truncated,
                table_json=element.table_json,
            )
        )
    return chunks


# ── Prose ────────────────────────────────────────────────────────────────────


def _prose_chunks(
    elements: Sequence[SourceElement],
    *,
    tokenizer: Tokenizer,
    options: ChunkingOptions,
) -> list[Chunk]:
    """Pack the document's prose into chunks in the target band."""
    if not elements:
        return []
    budget = _body_budget(options)
    pieces = _explode(elements, tokenizer=tokenizer, options=budget)
    groups = _pack(pieces, tokenizer=tokenizer, options=budget)
    groups = _coalesce(groups, tokenizer=tokenizer, options=budget)
    return _assemble(groups, tokenizer=tokenizer, options=options)


#: Tokens set aside for the breadcrumb. A `Financials > Revenue` is three or
#: four; sixteen covers a deep hierarchy without measuring one per group.
_BREADCRUMB_ALLOWANCE = 16


def _body_budget(options: ChunkingOptions) -> ChunkingOptions:
    """The band the packer works in, which is not the band a chunk is held to.

    A chunk's stored `token_count` is the count of what gets embedded: the
    breadcrumb, the overlap carried from the previous chunk, and the body. The
    packer only ever sees the body, so packing to the configured ceiling
    produced 980-token chunks from a 900-token limit — the overlap was added
    afterwards and nothing was left for it.

    The ceiling and the target come down by the overlap and the breadcrumb; the
    *floor* does not. Lowering the floor too would let a body of 480 tokens
    through, which is under the floor for the first chunk of a document — the
    one chunk that has no overlap to make up the difference.
    """
    reserve = options.overlap_tokens + _BREADCRUMB_ALLOWANCE
    return ChunkingOptions(
        target_tokens=max(options.min_tokens, options.target_tokens - reserve),
        min_tokens=options.min_tokens,
        max_tokens=max(options.min_tokens, options.max_tokens - reserve),
        overlap_ratio=options.overlap_ratio,
        boundary_heading_level=options.boundary_heading_level,
    )


def _explode(
    elements: Sequence[SourceElement],
    *,
    tokenizer: Tokenizer,
    options: ChunkingOptions,
) -> list[SourceElement]:
    """Break any element larger than the target into parts.

    A 5,000-token paragraph is not a decision the packer can make: no grouping
    of it fits the band. Splitting it here, before packing, means the packer and
    the overlap both work in one currency — whole elements — and the parts keep
    the element's own page and box, so nothing becomes unlocatable.
    """
    parts: list[SourceElement] = []
    for element in elements:
        if tokenizer.count(element.text) <= options.target_tokens:
            parts.append(element)
            continue

        for index, slice_text in enumerate(
            _split_text(element.text, tokenizer=tokenizer, limit=options.target_tokens), start=1
        ):
            parts.append(element.part(index, slice_text, slice_text))
    return parts


def _split_text(text: str, *, tokenizer: Tokenizer, limit: int) -> list[str]:
    """Greedy split on sentence boundaries, falling back to words."""
    units = [unit.strip() for unit in _SENTENCE_BOUNDARY.split(text) if unit and unit.strip()]
    if not units:
        return [text]

    # A single "sentence" longer than the limit — a table of contents with no
    # punctuation, a minified string — is broken on words, which is always
    # available. Below that there is nothing left to break on that a reader
    # would recognise as a break.
    expanded: list[str] = []
    for unit in units:
        if tokenizer.count(unit) <= limit:
            expanded.append(unit)
        else:
            expanded.extend(_split_on_words(unit, tokenizer=tokenizer, limit=limit))

    out: list[str] = []
    current: list[str] = []
    current_tokens = 0
    for unit in expanded:
        unit_tokens = tokenizer.count(unit)
        if current and current_tokens + unit_tokens > limit:
            out.append(" ".join(current))
            current, current_tokens = [], 0
        current.append(unit)
        current_tokens += unit_tokens
    if current:
        out.append(" ".join(current))
    return out


def _split_on_words(text: str, *, tokenizer: Tokenizer, limit: int) -> list[str]:
    out: list[str] = []
    current: list[str] = []
    for word in text.split():
        current.append(word)
        if len(current) > 1 and tokenizer.count(" ".join(current)) > limit:
            out.append(" ".join(current[:-1]))
            current = [word]
    if current:
        out.append(" ".join(current))
    return out


def _chunk_count(total: int, options: ChunkingOptions) -> int:
    """How many chunks this much prose should become.

    Deciding the *count* before the boundaries is what keeps the last chunk in
    the band. Packing greedily at the configured target leaves a remainder —
    2,455 tokens at a target of 664 is three full chunks and a 250-token orphan
    — and an orphan is precisely the chunk that gets retrieved on its own and
    says nothing. Four chunks of 614 is the same text with nothing left over.

    The count is clamped so the arithmetic cannot ask for something the band
    forbids: at least enough chunks that none must exceed the ceiling, at most
    enough that none need fall below the floor. Where those two cross — a
    document whose paragraphs are too coarse to divide evenly — there is no
    banded answer, and the honest result is a chunk that is simply small.
    """
    if total <= options.max_tokens:
        return 1

    fewest = -(-total // options.max_tokens)
    most = max(1, total // options.min_tokens)
    preferred = max(1, round(total / options.target_tokens))
    return max(fewest, min(preferred, most)) if most >= fewest else preferred


def _pack(
    pieces: Sequence[SourceElement],
    *,
    tokenizer: Tokenizer,
    options: ChunkingOptions,
) -> list[list[SourceElement]]:
    """Group consecutive pieces into chunk-sized runs.

    The target is *re-derived after every flush* from what is left and how many
    chunks are still to come. A fixed target accumulates error: paragraphs do
    not divide evenly into it, every chunk overshoots by a little, and the
    overshoot is paid for entirely by the last chunk. Recomputing spreads it,
    which is the difference between `[738, 854, 854, 369]` and four chunks that
    are all inside the band.
    """
    sizes = [tokenizer.count(piece.text) for piece in pieces]
    remaining = sum(sizes)
    remaining_chunks = _chunk_count(remaining, options)
    target = -(-remaining // remaining_chunks)

    groups: list[list[SourceElement]] = []
    current: list[SourceElement] = []
    current_tokens = 0

    def flush() -> None:
        nonlocal current, current_tokens, remaining, remaining_chunks, target
        groups.append(current)
        remaining -= current_tokens
        remaining_chunks = max(1, remaining_chunks - 1)
        target = max(options.min_tokens, -(-remaining // remaining_chunks)) if remaining else target
        current, current_tokens = [], 0

    for piece, piece_tokens in zip(pieces, sizes, strict=True):
        starts_section = (
            piece.is_heading
            and piece.level is not None
            and piece.level <= options.boundary_heading_level
        )

        if current and (
            # The band's ceiling is hard: nothing crosses it, even a chunk that
            # has not reached the floor.
            current_tokens + piece_tokens > options.max_tokens
            # A section boundary, honoured because the chunk is already worth
            # ending. Below the floor it is ignored and the sections merge.
            or (starts_section and current_tokens >= options.min_tokens)
            # At the target. Stopping short of it beats overshooting, because
            # the shortfall is redistributed and an overshoot is not.
            or (current_tokens >= options.min_tokens and current_tokens + piece_tokens > target)
        ):
            flush()

        current.append(piece)
        current_tokens += piece_tokens

    if current:
        groups.append(current)
    return groups


def _coalesce(
    groups: Sequence[list[SourceElement]],
    *,
    tokenizer: Tokenizer,
    options: ChunkingOptions,
) -> list[list[SourceElement]]:
    """Fold an undersized group into its neighbour when one will take it.

    `_even_target` removes most remainders before they exist; this catches what
    coarse paragraphs leave behind. The ceiling is the band's, not some looser
    hard limit: a merge that produced a 1,100-token chunk would trade one chunk
    below the band for one above it.
    """
    merged: list[list[SourceElement]] = []
    for group in groups:
        tokens = _tokens_of(group, tokenizer)
        if merged and tokens < options.min_tokens:
            previous = merged[-1]
            if _tokens_of(previous, tokenizer) + tokens <= options.max_tokens:
                previous.extend(group)
                continue
        merged.append(list(group))
    return merged


def _assemble(
    groups: Sequence[list[SourceElement]],
    *,
    tokenizer: Tokenizer,
    options: ChunkingOptions,
) -> list[Chunk]:
    """Render each group as a chunk, with the overlap from its predecessor."""
    chunks: list[Chunk] = []

    for index, group in enumerate(groups):
        overlap = (
            _overlap(groups[index - 1], tokenizer=tokenizer, budget=options.overlap_tokens)
            if index > 0
            else []
        )
        members = [*overlap, *group]

        breadcrumb = _group_breadcrumb(group)
        body = "\n\n".join(piece.markdown or piece.text for piece in members if piece.text.strip())
        text = _compose(breadcrumb, body)

        chunks.append(
            Chunk(
                ordinal=0,
                # The group's own first element, not the overlap's: the overlap
                # belongs, for ordering purposes, to the chunk it came from.
                start=group[0].order,
                text=text,
                token_count=tokenizer.count(text),
                section_path=breadcrumb,
                pages=_union_pages(members),
                kind="prose",
                element_ids=[piece.id for piece in members],
            )
        )
    return chunks


def _overlap(
    group: Sequence[SourceElement], *, tokenizer: Tokenizer, budget: int
) -> list[SourceElement]:
    """The trailing elements of the previous group that fit the overlap budget.

    Whole elements, taken from the end. Element-level rather than token-level so
    that the repeated text arrives with its page and box: a quote a model draws
    out of the overlap is then still inside this chunk's own rectangles, which is
    what mechanical citation verification needs.
    """
    if budget <= 0:
        return []

    taken: list[SourceElement] = []
    tokens = 0
    for element in reversed(group):
        element_tokens = tokenizer.count(element.text)
        if tokens + element_tokens > budget:
            break
        taken.append(element)
        tokens += element_tokens
        if tokens >= budget:
            break

    if taken:
        return list(reversed(taken))

    # Nothing fit whole, which is the case that matters most: a long paragraph
    # split into parts has parts far larger than the overlap budget, and giving
    # up on the overlap there would leave the one boundary most likely to cut a
    # sentence in half with no bridge across it. So the tail of the last element
    # is carried instead, keeping that element's page and box.
    last = group[-1]
    tail = _tail_within(last.text, tokenizer=tokenizer, budget=budget)
    return [last.part("tail", tail, tail)] if tail else []


def _tail_within(text: str, *, tokenizer: Tokenizer, budget: int) -> str:
    """The longest run of trailing sentences that fits the budget."""
    units = [unit.strip() for unit in _SENTENCE_BOUNDARY.split(text) if unit and unit.strip()]
    kept: list[str] = []
    tokens = 0
    for unit in reversed(units):
        unit_tokens = tokenizer.count(unit)
        if kept and tokens + unit_tokens > budget:
            break
        kept.append(unit)
        tokens += unit_tokens
        if tokens >= budget:
            break
    if not kept:
        return ""
    # One sentence can still be longer than the budget on its own; trimmed from
    # the front, because the end is the part adjacent to the next chunk.
    joined = " ".join(reversed(kept))
    if tokenizer.count(joined) <= budget:
        return joined
    words = joined.split()
    while words and tokenizer.count(" ".join(words)) > budget:
        words.pop(0)
    return " ".join(words)


# ── Shared ───────────────────────────────────────────────────────────────────


def _tokens_of(group: Iterable[SourceElement], tokenizer: Tokenizer) -> int:
    return sum(tokenizer.count(element.text) for element in group)


def _group_breadcrumb(group: Sequence[SourceElement]) -> str | None:
    """The section a chunk belongs to.

    Two cases neither of which is "the first element's `sectionPath`".

    An element's `sectionPath` holds the headings *above* it, and a heading's own
    trail excludes itself — so the chunk that opens a section, the one beginning
    `# Financials`, would otherwise be the single chunk in the document with no
    breadcrumb, which is the opposite of what it should say.

    And a chunk that merged two small sibling sections belongs to both, so it is
    labelled with what they have in common. The sections' own headings are still
    in the chunk body, so nothing is lost — the breadcrumb just stops claiming
    the whole passage came from the first of them.
    """
    paths = [_own_path(element) for element in group]
    common: list[str] = []
    for depth in range(min(len(path) for path in paths)):
        level = {path[depth] for path in paths}
        if len(level) != 1:
            break
        common.append(paths[0][depth])
    return _breadcrumb(common)


def _own_path(element: SourceElement) -> list[str]:
    """The section path an element is *in*, a heading's own text included."""
    path = list(element.section_path)
    if element.is_heading and element.text.strip():
        path.append(element.text.strip())
    return path


def _breadcrumb(section_path: Sequence[str]) -> str | None:
    parts = [part.strip() for part in section_path if part.strip()]
    return SECTION_PATH_SEPARATOR.join(parts) if parts else None


def _compose(breadcrumb: str | None, body: str) -> str:
    return f"{breadcrumb}\n\n{body}" if breadcrumb else body


def _union_pages(elements: Iterable[SourceElement]) -> list[dict[str, Any]]:
    """One rectangle per page, ascending.

    The union rather than every element's box, because a highlight is drawn per
    page: three paragraphs on page four are one region to light up, and three
    boxes would have the viewer draw three overlapping rectangles. Ascending, so
    the first entry is where a citation scrolls to.
    """
    boxes: dict[int, list[float]] = {}
    for element in elements:
        x0, y0, x1, y1 = element.bbox
        current = boxes.get(element.page)
        if current is None:
            boxes[element.page] = [x0, y0, x1, y1]
            continue
        current[0] = min(current[0], x0)
        current[1] = min(current[1], y0)
        current[2] = max(current[2], x1)
        current[3] = max(current[3], y1)

    return [
        {"page": page, "bbox": [round(value, 2) for value in boxes[page]]} for page in sorted(boxes)
    ]
