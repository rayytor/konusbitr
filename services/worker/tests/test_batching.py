"""Reading a long document in batches: the division, the resume, the accumulation.

These are the unit-level claims of Phase 12.4. The end-to-end ones — a
checkpoint surviving a kill, a cancellation landing inside two seconds — live in
`test_resumable_ingest.py`, because they need the pipeline and the runtime. What
is here is the arithmetic those depend on, which is worth testing separately
because getting it wrong is silent: a document that comes back with a hole in
the middle looks exactly like a document that came back whole.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

from konusbitr_worker.contracts import JOB_CHECKPOINT_VERSION
from konusbitr_worker.parse.artifact import (
    ElementType,
    PageTier,
    ParsedElement,
    ParsedPage,
)
from konusbitr_worker.parse.batching import (
    ParseAccumulator,
    page_batches,
    resume_state_from,
)
from konusbitr_worker.parse.geometry import BBox


def element(page: int, text: str = "words") -> ParsedElement:
    return ParsedElement(
        id="el_0000",
        type=ElementType.paragraph,
        text=text,
        markdown=text,
        page=page,
        bbox=BBox(72.0, 100.0, 540.0, 150.0),
    )


def page(page_no: int, tier: PageTier = PageTier.native) -> ParsedPage:
    return ParsedPage(page_no=page_no, width=612.0, height=792.0, tier=tier)


# ── Dividing the document ────────────────────────────────────────────────────


def test_batches_cover_every_page_exactly_once() -> None:
    """The property everything else rests on: a partition, not an overlap.

    A page read twice is an element written twice and a passage retrieved
    twice; a page skipped is a hole nothing downstream can detect. Both are
    silent, so the division is checked rather than assumed.
    """
    batches = list(page_batches(page_count=900, scanned_pages=set(), batch_size=16))
    covered = [page_no for batch in batches for page_no in batch.pages]
    assert covered == list(range(1, 901))


def test_a_document_shorter_than_a_batch_is_one_batch() -> None:
    """The ordinary upload, which must behave exactly as it did before this phase."""
    batches = list(page_batches(page_count=10, scanned_pages=set(), batch_size=16))
    assert len(batches) == 1
    assert (batches[0].first_page, batches[0].last_page) == (1, 10)


def test_each_batch_knows_which_tier_reads_which_of_its_pages() -> None:
    """A mixed filing is split by tier *within* a batch, not across batches."""
    batch = next(page_batches(page_count=20, scanned_pages={3, 4, 19}, batch_size=16))
    assert batch.scanned == {3, 4}
    assert 19 not in batch.native
    assert batch.native == set(range(1, 17)) - {3, 4}


def test_resuming_never_reopens_a_committed_page() -> None:
    """The crash-recovery criterion, as arithmetic.

    A worker killed at page 450 of 900 must restart at 451. Re-reading the
    first 450 is not merely slow — on a document parsed with captions it is
    450 pages of vision-model spend the reader has already paid for.
    """
    batches = list(
        page_batches(page_count=900, scanned_pages=set(), batch_size=16, start_after=450)
    )
    assert batches[0].first_page == 451
    assert min(page_no for batch in batches for page_no in batch.pages) == 451


# ── Accumulating across batches ──────────────────────────────────────────────


def test_element_ids_stay_a_reading_order_sort_across_batches() -> None:
    """`element_id` is zero-padded so a lexical sort is a reading-order sort.

    That promise has to survive being built in pieces. Two independently
    numbered batches concatenated would give two elements called `el_0000`,
    which breaks every consumer that sorts by id — and breaks it on long
    documents only, which is the worst possible place for it to show up.
    """
    accumulator = ParseAccumulator(page_count=40)
    accumulator.extend(
        elements=[element(1), element(2)], pages=[page(1), page(2)], images=[], last_page=16
    )
    accumulator.extend(
        elements=[element(17), element(18)], pages=[page(17), page(18)], images=[], last_page=32
    )

    ids = [item.id for item in accumulator.elements]
    assert ids == sorted(ids)
    assert len(set(ids)) == 4
    assert [item.page for item in accumulator.elements] == [1, 2, 17, 18]


def test_the_batch_is_handed_back_with_the_ids_it_was_given() -> None:
    """The caller chunks the batch, so it must see the numbering that was stored.

    Renumbering after the chunker had run would leave chunks citing element ids
    that no longer exist under those names.
    """
    accumulator = ParseAccumulator(page_count=40)
    accumulator.extend(elements=[element(1)], pages=[page(1)], images=[], last_page=16)
    committed = accumulator.extend(
        elements=[element(17)], pages=[page(17)], images=[], last_page=32
    )
    assert [item.id for item in committed] == [accumulator.elements[1].id]


def test_markdown_keeps_doclings_export_until_a_page_is_recognised() -> None:
    """Two renderings, and the rule for choosing between them.

    Docling's own export is richer than anything recomposed from elements — it
    knows about cells with line breaks and nested lists. It is kept while the
    whole document is born-digital, and dropped the moment one page is
    recognised, because then it covers only part of the document and a
    consistent rendering of all of it is worth more than a better rendering of
    half.
    """
    accumulator = ParseAccumulator(page_count=40)
    accumulator.markdown_parts.append("# Chapter one")
    accumulator.extend(elements=[element(1)], pages=[page(1)], images=[], last_page=16)
    assert accumulator.markdown() == "# Chapter one"

    accumulator.any_recognized = True
    accumulator.extend(
        elements=[element(17, "recognised")],
        pages=[page(17, PageTier.ocr)],
        images=[],
        last_page=32,
    )
    assert "recognised" in accumulator.markdown()


# ── Reading a checkpoint back ────────────────────────────────────────────────


def stored(accumulator: ParseAccumulator, *, batch_size: int) -> dict[str, object]:
    return accumulator.checkpoint(batch_size=batch_size, now=datetime.now(UTC).isoformat())


def test_a_checkpoint_round_trips_through_the_stored_artifact() -> None:
    accumulator = ParseAccumulator(page_count=40)
    accumulator.extend(elements=[element(1)], pages=[page(1)], images=[], last_page=16)
    accumulator.chunks_written = 7

    state = resume_state_from(
        stored(accumulator, batch_size=16),
        accumulator.artifact().to_json(include_markdown=False),
        batch_size=16,
    )

    assert state is not None
    assert state.last_processed_page == 16
    assert state.chunks_written == 7
    assert [item.page for item in state.elements] == [1]
    assert [item.page_no for item in state.pages] == [1]


def test_a_checkpoint_at_a_different_batch_size_is_refused() -> None:
    """Re-reading is expensive; resuming onto the wrong boundary is wrong.

    A resume has to land on the page boundaries the interrupted run used. An
    operator who changed `WORKER_PAGE_BATCH_SIZE` mid-flight gets the document
    read again from the start, which costs time — rather than a document
    stitched together at two different strides, which costs correctness.
    """
    accumulator = ParseAccumulator(page_count=40)
    accumulator.extend(elements=[element(1)], pages=[page(1)], images=[], last_page=16)

    assert (
        resume_state_from(
            stored(accumulator, batch_size=16),
            accumulator.artifact().to_json(include_markdown=False),
            batch_size=20,
        )
        is None
    )


def test_a_checkpoint_from_another_build_is_refused() -> None:
    accumulator = ParseAccumulator(page_count=40)
    accumulator.extend(elements=[element(1)], pages=[page(1)], images=[], last_page=16)
    checkpoint = stored(accumulator, batch_size=16)
    checkpoint["version"] = JOB_CHECKPOINT_VERSION + 1

    assert (
        resume_state_from(
            checkpoint,
            accumulator.artifact().to_json(include_markdown=False),
            batch_size=16,
        )
        is None
    )


def test_a_checkpoint_with_no_artifact_behind_it_is_refused() -> None:
    """The row was truncated or hand-edited. Starting over is the honest answer."""
    accumulator = ParseAccumulator(page_count=40)
    accumulator.extend(elements=[element(1)], pages=[page(1)], images=[], last_page=16)
    assert resume_state_from(stored(accumulator, batch_size=16), None, batch_size=16) is None


def test_a_resumed_accumulator_continues_the_numbering() -> None:
    """The end-to-end shape of a resume, without the database.

    Ordinals and element ids both have to continue rather than restart, because
    chunks are upserted on `(document_id, ordinal)` and everything past the
    final count is deleted. A batch that restarted its numbering would
    overwrite its predecessor's rows and then delete the document's tail.
    """
    first = ParseAccumulator(page_count=40)
    first.extend(
        elements=[element(1), element(2)], pages=[page(1), page(2)], images=[], last_page=16
    )
    first.chunks_written = 5

    state = resume_state_from(
        stored(first, batch_size=16),
        first.artifact().to_json(include_markdown=False),
        batch_size=16,
    )
    assert state is not None

    second = ParseAccumulator.resumed(40, state)
    assert second.chunks_written == 5
    committed = second.extend(elements=[element(17)], pages=[page(17)], images=[], last_page=32)
    assert committed[0].id == "el_0002"
    assert [item.page for item in second.elements] == [1, 2, 17]


# ── The VLM budget across batches (Phase 12.3 meets Phase 12.4) ─────────────


def test_the_escalation_budget_is_a_document_budget_not_a_batch_one() -> None:
    """A cap asked once per batch is not a cap.

    The vision tier's escalation path is capped rather than refused: a filing
    with two hundred illegible pages gets its best fifty. But the batched loop
    asks the question once per page batch, and passing the whole ceiling each
    time would let a 900-page document with two bad pages in each of its
    fifty-six batches spend a hundred and twelve model calls against a ceiling
    of fifty — one batch at a time, with nothing in the log to say so. What is
    left of the budget is passed down instead.
    """
    from konusbitr_worker.parse import _pages_to_look_at

    inspection = SimpleNamespace(pages=[SimpleNamespace(page_no=n) for n in range(1, 13)])
    settings = SimpleNamespace(tier_fallback_threshold=0.6, max_vlm_pages_per_job=3)
    badly_read = [SimpleNamespace(page_no=n, confidence=0.2) for n in (1, 2, 3, 4, 5)]

    spent_whole_ceiling = _pages_to_look_at(
        inspection, badly_read, settings, advanced=False, enabled=True
    )
    assert len(spent_whole_ceiling) == 3

    # Two already spent by earlier batches leaves one.
    assert _pages_to_look_at(
        inspection, badly_read, settings, advanced=False, enabled=True, budget=1
    ) == [1]
    # And an exhausted budget buys nothing rather than wrapping round to the
    # full ceiling.
    assert (
        _pages_to_look_at(inspection, badly_read, settings, advanced=False, enabled=True, budget=0)
        == []
    )
