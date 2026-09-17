"""Reading a document a page batch at a time, and being able to stop.

Phases 07 through 12.2 read a document in one pass: inspect it, hand every
born-digital page to Docling, hand every scanned page to the recogniser, and
return one artifact. That is the right shape for the documents most people
upload and the wrong shape for the ones this phase is about. A 900-page scan
read in one pass holds hundreds of decoded bitmaps, takes a quarter of an hour
before a reader may ask their first question, and loses all of it to a
container restart at page 850.

So the pass becomes a loop, and this module is the loop's state. What it adds
to the pipeline is exactly three things:

**A batch is a commit point.** Everything in a batch — the elements, the page
rows, the figures — belongs to one contiguous span of pages, and when the span
is done the caller writes it durably and records how far it got. Nothing
straddles a batch boundary, which is what makes a resume a matter of starting
at the next page rather than of reconciling partial state.

**Accumulation is append-only and globally numbered.** Element ids are
zero-padded so that a lexical sort is a reading-order sort, and that promise
has to survive being built in fifty-six pieces. The accumulator therefore
numbers each batch's elements from the running total rather than from zero, and
because batches arrive in page order the result is identical to what a single
pass would have produced.

**Cancellation and resumption are the same mechanism seen from two sides.**
Both are "this run covers pages *a* to *b* rather than 1 to *n*", and both are
settled by the plan the loop is handed rather than by a special case inside it.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from typing import Any

from konusbitr_worker.contracts import DEFAULT_PAGE_BATCH_SIZE, JOB_CHECKPOINT_VERSION
from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.artifact import (
    PageTier,
    ParseArtifact,
    ParsedElement,
    ParsedPage,
    element_id,
    markdown_from_elements,
)

__all__ = [
    "PageBatch",
    "ParseAccumulator",
    "ResumeState",
    "page_batches",
    "resume_state_from",
]

logger = get_logger("konusbitr.worker.parse.batching")


@dataclass(frozen=True, slots=True)
class PageBatch:
    """One contiguous span of pages, and which tier reads each of them."""

    #: 1-based, inclusive at both ends.
    first_page: int
    last_page: int
    #: The pages in this span Docling will read, and the ones the recogniser will.
    native: set[int]
    scanned: set[int]

    @property
    def pages(self) -> list[int]:
        return list(range(self.first_page, self.last_page + 1))

    @property
    def size(self) -> int:
        return self.last_page - self.first_page + 1


def page_batches(
    *,
    page_count: int,
    scanned_pages: set[int],
    batch_size: int = DEFAULT_PAGE_BATCH_SIZE,
    start_after: int = 0,
) -> Iterator[PageBatch]:
    """Divide a document into the spans it will be read in.

    `start_after` is the resume point: a checkpoint saying page 60 was the last
    one committed produces batches beginning at 61, and the pages before it are
    never opened again. It is the whole of the crash-recovery story from this
    module's side.

    Spans are contiguous and equal-sized rather than balanced by tier, which is
    a deliberate simplification: a batch of sixteen scanned pages costs far
    more than a batch of sixteen born-digital ones, so the *time* per batch
    varies. Making the spans contiguous is what lets a checkpoint be a single
    page number, and a single page number is what makes the resume unambiguous.
    Balancing by cost would buy smoother progress and pay for it with a
    checkpoint that had to enumerate which pages were done.
    """
    size = max(int(batch_size), 1)
    page = max(int(start_after), 0) + 1
    while page <= page_count:
        last = min(page + size - 1, page_count)
        span = set(range(page, last + 1))
        yield PageBatch(
            first_page=page,
            last_page=last,
            native=span - scanned_pages,
            scanned=span & scanned_pages,
        )
        page = last + 1


@dataclass(frozen=True, slots=True)
class ResumeState:
    """What a previous run of this job already committed.

    Reconstructed from the incomplete `parse_results` row rather than carried
    in the queue message, because a stream entry is redelivered as it was
    written — it cannot know what happened after it. The row is the only thing
    that saw the work.
    """

    last_processed_page: int
    chunks_written: int
    elements: list[ParsedElement]
    pages: list[ParsedPage]
    images: list[dict[str, Any]]
    #: The markdown committed so far, so that a resumed born-digital document
    #: keeps Docling's own export for the pages that were read before the
    #: crash rather than having them re-composed from elements.
    markdown: str = ""

    @property
    def is_useful(self) -> bool:
        """Whether resuming from this is better than starting over.

        A checkpoint at page zero is not worth honouring: nothing was
        committed, and the bookkeeping to resume from it costs more than the
        nothing it saves.
        """
        return self.last_processed_page > 0


def resume_state_from(
    checkpoint: dict[str, Any] | None,
    contents: dict[str, Any] | list[Any] | None,
    *,
    markdown: str | None = None,
    batch_size: int,
) -> ResumeState | None:
    """Read a stored checkpoint, or decide not to.

    Returns `None` for every shape this build cannot vouch for, and that is the
    safe direction: re-reading 850 pages costs time, while resuming from a
    checkpoint whose meaning has changed underneath it produces a document with
    a hole in the middle that nothing downstream can detect. The cases are

    - a checkpoint written by a different envelope version,
    - a checkpoint written with a different batch size, because the page
      boundaries a resume must land on are the ones the earlier run used, and
    - a checkpoint whose artifact is missing or unreadable, which is the row
      having been written by hand or truncated.

    A rejected checkpoint is logged at warning level. Silently re-parsing a
    900-page document is a fifteen-minute surprise, and an operator who changed
    ``WORKER_PAGE_BATCH_SIZE`` mid-flight deserves to be told that is why.
    """
    if not isinstance(checkpoint, dict):
        return None

    if checkpoint.get("version") != JOB_CHECKPOINT_VERSION:
        logger.warning(
            "ignoring a checkpoint written by a different build",
            extra={"version": checkpoint.get("version")},
        )
        return None

    if int(checkpoint.get("batchSize") or 0) != batch_size:
        logger.warning(
            "ignoring a checkpoint taken at a different batch size",
            extra={"checkpoint": checkpoint.get("batchSize"), "configured": batch_size},
        )
        return None

    if not isinstance(contents, dict):
        logger.warning("a checkpoint exists but its partial parse does not")
        return None

    elements = [
        element
        for element in (ParsedElement.from_json(raw) for raw in contents.get("contents") or [])
        if element is not None
    ]
    pages = [
        page
        for page in (ParsedPage.from_json(raw) for raw in contents.get("pages") or [])
        if page is not None
    ]

    return ResumeState(
        last_processed_page=max(int(checkpoint.get("lastProcessedPage") or 0), 0),
        chunks_written=max(int(checkpoint.get("chunksWritten") or 0), 0),
        elements=elements,
        pages=pages,
        images=[image for image in (contents.get("images") or []) if isinstance(image, dict)],
        markdown=markdown or "",
    )


@dataclass(slots=True)
class ParseAccumulator:
    """The document as it stands after the batches read so far.

    Holds the whole parse, which is unavoidable: the artifact is written whole
    to ``parse_results`` and read whole by the chunker, so there is no version
    of this that streams. What it deliberately does *not* hold is anything
    page-shaped — no bitmaps, no rendered images, no engine state — so its size
    is a function of the document's text rather than of its page count in
    pixels, which is the difference between tens of megabytes and tens of
    gigabytes.
    """

    page_count: int
    elements: list[ParsedElement] = field(default_factory=list)
    pages: list[ParsedPage] = field(default_factory=list)
    images: list[dict[str, Any]] = field(default_factory=list)
    timings: dict[str, int] = field(default_factory=dict)
    #: Digests of figures already stored, so the letterhead repeated on every
    #: page is stored once for the document rather than once per batch.
    #:
    #: **Not restored on a resume**, and deliberately so. The digests are not in
    #: the stored artifact — only the figures' ids, boxes and storage keys are,
    #: and recovering a digest would mean fetching every stored image back out
    #: of the bucket. The cost of not restoring it is bounded and cosmetic: a
    #: decoration repeated throughout a document is stored one extra time after
    #: a crash, for the batches that follow the resume. Paying for that with a
    #: contract change to the artifact, or with a round trip to storage per
    #: figure, is the worse trade.
    seen_images: set[str] = field(default_factory=set)
    #: Docling's own markdown export, one entry per batch that produced any.
    #:
    #: Kept alongside the elements rather than derived from them because
    #: Docling's export is better than anything recomposed: it knows about
    #: cells containing line breaks, nested lists and inline emphasis that the
    #: element vocabulary deliberately flattens. It is used verbatim for a
    #: document with no recognised pages, and dropped in favour of a composed
    #: markdown the moment one page is recognised — because then the export
    #: covers only part of the document, which is worse than a consistent
    #: rendering of all of it.
    markdown_parts: list[str] = field(default_factory=list)
    #: Whether any page of this document was read by the recogniser.
    any_recognized: bool = False
    #: How far the last committed batch got. Zero before the first one.
    last_processed_page: int = 0
    #: Chunks written by earlier batches; where the next batch's ordinals start.
    chunks_written: int = 0

    @classmethod
    def resumed(cls, page_count: int, state: ResumeState | None) -> ParseAccumulator:
        if state is None or not state.is_useful:
            return cls(page_count=page_count)
        return cls(
            page_count=page_count,
            elements=list(state.elements),
            pages=list(state.pages),
            images=list(state.images),
            last_processed_page=state.last_processed_page,
            chunks_written=state.chunks_written,
            markdown_parts=[state.markdown] if state.markdown else [],
            any_recognized=any(page.tier is PageTier.ocr for page in state.pages),
        )

    def extend(
        self,
        *,
        elements: Sequence[ParsedElement],
        pages: Sequence[ParsedPage],
        images: Sequence[dict[str, Any]],
        last_page: int,
    ) -> list[ParsedElement]:
        """Append one batch, renumbering its elements into the running sequence.

        Returns the batch's elements *as they were numbered*, because the
        caller chunks that batch and the chunks carry those ids. Renumbering
        after the chunker had seen them would leave citations pointing at
        elements that no longer exist under those names.
        """
        renumbered = [
            ParsedElement(
                id=element_id(len(self.elements) + offset),
                type=element.type,
                text=element.text,
                markdown=element.markdown,
                page=element.page,
                bbox=element.bbox,
                section_path=element.section_path,
                level=element.level,
                table=element.table,
            )
            for offset, element in enumerate(elements)
        ]
        self.elements.extend(renumbered)
        self.pages.extend(pages)
        self.images.extend(images)
        self.last_processed_page = max(self.last_processed_page, last_page)
        return renumbered

    def markdown(self) -> str:
        """The document's markdown as it stands. See :attr:`markdown_parts`."""
        if self.any_recognized:
            return markdown_from_elements(self.elements)
        return "\n\n".join(part for part in self.markdown_parts if part)

    def artifact(self) -> ParseArtifact:
        """The parse as it stands, whole and self-consistent at any batch boundary."""
        return ParseArtifact(
            markdown=self.markdown(),
            page_count=self.page_count,
            contents=list(self.elements),
            pages=list(self.pages),
            images=list(self.images),
            timings=dict(self.timings),
        )

    def checkpoint(self, *, batch_size: int, now: str) -> dict[str, Any]:
        """The durable record of how far this is, in the shape both runtimes agree on."""
        return {
            "version": JOB_CHECKPOINT_VERSION,
            "lastProcessedPage": self.last_processed_page,
            "totalPages": self.page_count,
            "batchSize": batch_size,
            "chunksWritten": self.chunks_written,
            "updatedAt": now,
        }

    def add_timing(self, stage: str, milliseconds: int) -> None:
        """Accumulate a stage's cost across every batch that spent time in it."""
        self.timings[stage] = self.timings.get(stage, 0) + milliseconds
