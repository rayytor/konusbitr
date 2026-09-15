"""The chunker's boundary behaviour, element by element.

Chunk quality dominates answer quality, and the ways a chunker goes wrong are
all boundary cases: a table cut in half, a paragraph nobody can split, a section
that runs for thirty pages, a document too small to chunk at all. Each of those
gets a test here, built from hand-written elements rather than from a parse, so
that a failure says which rule broke rather than which PDF changed.

`test_corpus_chunking.py` is the other half: the same chunker over the real
fixtures, where the band statistics are measured.
"""

from __future__ import annotations

from itertools import pairwise

import pytest

from konusbitr_worker.ai.tokens import Tokenizer
from konusbitr_worker.chunk import (
    MAX_CHUNK_CONTEXT_TOKENS,
    TRUNCATION_MARKER,
    ChunkingOptions,
    chunk_elements,
    elements_from_contents,
    figure_elements,
)

#: A model with a real tokenizer, so the band is measured in the units the
#: chunker claims to measure it in rather than in characters.
MODEL = "text-embedding-3-large"


@pytest.fixture
def tokenizer() -> Tokenizer:
    return Tokenizer(MODEL)


@pytest.fixture
def options() -> ChunkingOptions:
    return ChunkingOptions()


def element(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "id": "el_0000",
        "type": "paragraph",
        "text": "Revenue grew.",
        "page": 1,
        "bbox": [72, 100, 540, 140],
        "sectionPath": [],
    }
    base.update(overrides)
    # The chunker renders `markdown` and measures `text`, so a test that set
    # only one of them would be measuring different prose from the prose it
    # asserts about.
    base.setdefault("markdown", base["text"])
    return base


def base_ids(chunk_ids: list[str]) -> set[str]:
    """Element ids with any `#part` suffix removed.

    An oversized element is split into parts and an overlap may carry a tail
    slice, so `el_0003` and `el_0003#tail` are the same element of the document.
    """
    return {chunk_id.split("#")[0] for chunk_id in chunk_ids}


#: Tokens in one `itemN counts.` unit under cl100k, which is what the OpenAI
#: embedding models use. Measured rather than guessed: a helper that claimed to
#: produce 400 tokens and produced 660 would make every band assertion here
#: about a size the test never intended.
_TOKENS_PER_UNIT = 4


def words(count: int) -> str:
    """Roughly `count` tokens of prose, with sentence boundaries to split on."""
    return " ".join(f"item{index} counts." for index in range(max(1, count // _TOKENS_PER_UNIT)))


def chunk(contents: list[dict[str, object]], *, tokenizer: Tokenizer, **kwargs: object):
    options = ChunkingOptions(**kwargs) if kwargs else ChunkingOptions()
    return chunk_elements(elements_from_contents(contents), tokenizer=tokenizer, options=options)


# ── Location ─────────────────────────────────────────────────────────────────


def test_every_chunk_carries_at_least_one_page_and_box(tokenizer: Tokenizer) -> None:
    """The load-bearing rule: an uncitable chunk is the failure to prevent."""
    chunks = chunk([element(text=words(200))], tokenizer=tokenizer)

    assert chunks
    for produced in chunks:
        assert produced.pages
        for entry in produced.pages:
            assert entry["page"] >= 1
            x0, y0, x1, y1 = entry["bbox"]
            assert x0 <= x1 and y0 <= y1


def test_a_chunk_spanning_a_page_break_has_an_entry_for_both_pages(
    tokenizer: Tokenizer,
) -> None:
    chunks = chunk(
        [
            element(id="el_0000", text=words(300), page=8, bbox=[72, 500, 540, 700]),
            element(id="el_0001", text=words(300), page=9, bbox=[72, 90, 540, 300]),
        ],
        tokenizer=tokenizer,
    )

    assert len(chunks) == 1
    assert [entry["page"] for entry in chunks[0].pages] == [8, 9]


def test_boxes_on_one_page_are_unioned_into_the_region_to_highlight(
    tokenizer: Tokenizer,
) -> None:
    # One rectangle per page, not one per element: three paragraphs on a page
    # are one region to light up, and three boxes would draw three overlapping
    # highlights.
    chunks = chunk(
        [
            element(id="el_0000", text=words(150), bbox=[100, 100, 300, 140]),
            element(id="el_0001", text=words(150), bbox=[72, 200, 540, 260]),
        ],
        tokenizer=tokenizer,
    )

    assert chunks[0].pages == [{"page": 1, "bbox": [72.0, 100.0, 540.0, 260.0]}]


def test_an_element_with_no_usable_box_is_dropped(tokenizer: Tokenizer) -> None:
    # A chunk built from it could not be cited, so it must not become one.
    chunks = chunk(
        [element(id="el_0000", bbox=None), element(id="el_0001", text=words(100))],
        tokenizer=tokenizer,
    )

    assert [produced.element_ids for produced in chunks] == [["el_0001"]]


# ── Tables ───────────────────────────────────────────────────────────────────


def test_a_table_is_never_split(tokenizer: Tokenizer) -> None:
    """Half a table answers nothing: the header and the number get separated."""
    table = element(
        id="el_0001",
        type="table",
        text="Year Revenue\n2024 18\n2023 15",
        markdown="| Year | Revenue |\n| --- | --- |\n"
        + "\n".join(f"| {y} | {y} |" for y in range(1900, 2100)),
        tableJson={"headers": ["Year", "Revenue"], "rows": [["2024", "18"]]},
    )

    chunks = chunk([table], tokenizer=tokenizer)

    assert len(chunks) == 1
    assert chunks[0].kind == "table"
    assert chunks[0].truncated is False
    # Well over the prose ceiling, and kept whole anyway.
    assert chunks[0].token_count > ChunkingOptions().max_tokens


def test_a_table_larger_than_the_model_context_is_truncated_visibly(
    tokenizer: Tokenizer,
) -> None:
    # The only case a table is cut. It is cut with a marker in the *text*,
    # because whatever reads the chunk has to be able to tell it is looking at
    # part of a table rather than all of one.
    enormous = "| a | b |\n" + "\n".join(f"| {n} | {n} |" for n in range(60_000))
    chunks = chunk([element(type="table", text=enormous, markdown=enormous)], tokenizer=tokenizer)

    assert len(chunks) == 1
    assert chunks[0].truncated is True
    assert TRUNCATION_MARKER in chunks[0].text
    assert chunks[0].token_count <= MAX_CHUNK_CONTEXT_TOKENS


def test_a_table_carries_its_json_into_the_chunk_metadata(tokenizer: Tokenizer) -> None:
    table_json = {"headers": ["Year"], "rows": [["2024"]]}
    chunks = chunk(
        [element(type="table", text="Year\n2024", markdown="| Year |", tableJson=table_json)],
        tokenizer=tokenizer,
    )

    assert chunks[0].to_meta()["tableJson"] == table_json


def test_a_table_interrupts_a_chunk_without_interrupting_the_prose(
    tokenizer: Tokenizer,
) -> None:
    """Otherwise a report alternating a sentence with a table is all fragments."""
    contents = [
        element(id="el_0000", text=words(300), page=1),
        element(id="el_0001", type="table", text="a", markdown="| a |", page=1),
        element(id="el_0002", text=words(300), page=2),
    ]

    chunks = chunk(contents, tokenizer=tokenizer)

    prose = [produced for produced in chunks if produced.kind == "prose"]
    assert len(prose) == 1
    assert base_ids(prose[0].element_ids) == {"el_0000", "el_0002"}
    # Reading order survives the two streams being chunked apart.
    assert [produced.kind for produced in chunks] == ["prose", "table"]
    assert [produced.ordinal for produced in chunks] == [0, 1]


# ── Sections ─────────────────────────────────────────────────────────────────


def test_a_substantive_chunk_ends_at_a_top_level_heading(tokenizer: Tokenizer) -> None:
    contents = [
        element(id="el_0000", type="heading", text="Financials", markdown="# Financials", level=1),
        element(id="el_0001", text=words(900), sectionPath=["Financials"]),
        element(id="el_0002", type="heading", text="Risks", markdown="# Risks", level=1),
        element(id="el_0003", text=words(900), sectionPath=["Risks"]),
    ]

    chunks = chunk(contents, tokenizer=tokenizer)

    assert [produced.section_path for produced in chunks[:1]] == ["Financials"]
    assert any(produced.section_path == "Risks" for produced in chunks)
    # No chunk mixes the two: a passage spanning both answers questions about
    # neither, and scores the average of two relevances.
    for produced in chunks:
        assert not (
            "Financials" in (produced.section_path or "")
            and "Risks" in (produced.section_path or "")
        )


def test_tiny_sibling_sections_merge_rather_than_becoming_fragments(
    tokenizer: Tokenizer,
) -> None:
    """The boundary rule is a means, not an end.

    Honoured absolutely it fights the band: the fixture corpus carries a
    heading on every page, and a 30-token section per heading produces nothing
    but fragments nobody can answer from. So a boundary below the floor is
    ignored, and the chunk is labelled with what the merged sections have in
    common.
    """
    contents = [
        element(
            id="el_0000", type="heading", text="Q1", markdown="## Q1", level=2, sectionPath=["Year"]
        ),
        element(id="el_0001", text=words(90), sectionPath=["Year", "Q1"]),
        element(
            id="el_0002", type="heading", text="Q2", markdown="## Q2", level=2, sectionPath=["Year"]
        ),
        element(id="el_0003", text=words(90), sectionPath=["Year", "Q2"]),
    ]

    chunks = chunk(contents, tokenizer=tokenizer)

    assert len(chunks) == 1
    assert chunks[0].section_path == "Year"
    # Both headings are still in the body, so nothing about where the text came
    # from is lost — the breadcrumb has just stopped claiming it is all Q1.
    assert "Q1" in chunks[0].text and "Q2" in chunks[0].text


def test_the_chunk_that_opens_a_section_is_labelled_with_it(tokenizer: Tokenizer) -> None:
    # A heading's own `sectionPath` excludes itself, so without special
    # handling this would be the one chunk in the document with no breadcrumb.
    contents = [
        element(
            id="el_0000",
            type="heading",
            text="Revenue",
            markdown="## Revenue",
            level=2,
            sectionPath=["Financials"],
        ),
        element(id="el_0001", text=words(700), sectionPath=["Financials", "Revenue"]),
    ]

    chunks = chunk(contents, tokenizer=tokenizer)

    assert chunks[0].section_path == "Financials > Revenue"
    assert chunks[0].text.startswith("Financials > Revenue\n\n")


def test_a_section_spanning_thirty_pages_is_split_and_stays_locatable(
    tokenizer: Tokenizer,
) -> None:
    contents = [
        element(id="el_0000", type="heading", text="Appendix", markdown="# Appendix", level=1),
        *[
            element(
                id=f"el_{page:04d}",
                text=words(240),
                page=page,
                bbox=[72, 100, 540, 700],
                sectionPath=["Appendix"],
            )
            for page in range(1, 31)
        ],
    ]

    chunks = chunk(contents, tokenizer=tokenizer)

    assert len(chunks) > 1
    assert all(produced.section_path == "Appendix" for produced in chunks)
    # Every page in the section appears in some chunk's location, so nothing in
    # thirty pages became uncitable.
    located = {entry["page"] for produced in chunks for entry in produced.pages}
    assert located == set(range(1, 31))


# ── Oversized and undersized ─────────────────────────────────────────────────


def test_a_five_thousand_token_paragraph_is_split_within_the_band(
    tokenizer: Tokenizer, options: ChunkingOptions
) -> None:
    """No grouping of it fits the band, so it is split before packing."""
    chunks = chunk([element(text=words(5_000))], tokenizer=tokenizer)

    assert len(chunks) > 4
    assert all(produced.token_count <= options.max_tokens for produced in chunks)
    # Each part keeps the whole paragraph's box, because that is the only
    # coordinate the parser produced. Inventing a tighter one per slice would
    # be a box no parser emitted, which `docs/coordinates.md` forbids.
    assert all(
        produced.pages == [{"page": 1, "bbox": [72.0, 100.0, 540.0, 140.0]}] for produced in chunks
    )


def test_a_paragraph_with_no_punctuation_is_still_split(tokenizer: Tokenizer) -> None:
    # A table of contents, a minified blob: nothing to break on but words.
    chunks = chunk(
        [element(text=" ".join(f"row{index}" for index in range(4_000)))], tokenizer=tokenizer
    )

    assert len(chunks) > 1
    assert all(produced.token_count <= ChunkingOptions().max_tokens for produced in chunks)


def test_a_tiny_document_becomes_one_small_chunk(tokenizer: Tokenizer) -> None:
    """There is no banded answer, and the honest result is one chunk.

    Not zero chunks: a two-line document is still a document somebody uploaded
    and expects to be able to ask about.
    """
    chunks = chunk([element(text="Revenue grew 18% year over year.")], tokenizer=tokenizer)

    assert len(chunks) == 1
    assert chunks[0].token_count < ChunkingOptions().min_tokens
    assert chunks[0].pages


def test_an_empty_document_produces_no_chunks(tokenizer: Tokenizer) -> None:
    assert chunk([], tokenizer=tokenizer) == []
    assert chunk([element(text="   ", markdown="   ")], tokenizer=tokenizer) == []


def test_an_empty_page_contributes_nothing_and_breaks_nothing(
    tokenizer: Tokenizer,
) -> None:
    # A blank page between two full ones must not appear in any chunk's
    # location — a citation pointing at an empty page is a citation that
    # highlights nothing.
    contents = [
        element(id="el_0000", text=words(400), page=1),
        element(id="el_0001", text="", markdown="", page=2, bbox=[0, 0, 612, 792]),
        element(id="el_0002", text=words(400), page=3),
    ]

    chunks = chunk(contents, tokenizer=tokenizer)

    located = {entry["page"] for produced in chunks for entry in produced.pages}
    assert located == {1, 3}


# ── Overlap and ordinals ─────────────────────────────────────────────────────


def test_consecutive_chunks_overlap_so_a_straddling_sentence_stays_findable(
    tokenizer: Tokenizer,
) -> None:
    contents = [
        element(id=f"el_{index:04d}", text=words(120), page=1 + index // 4) for index in range(24)
    ]

    chunks = chunk(contents, tokenizer=tokenizer)

    assert len(chunks) > 1
    for earlier, later in pairwise(chunks):
        assert base_ids(earlier.element_ids) & base_ids(later.element_ids)


def test_the_overlap_brings_its_pages_with_it(tokenizer: Tokenizer) -> None:
    """Which is the whole reason the overlap is element-level.

    A quote a model draws out of the overlap has to be inside the chunk's own
    rectangles, or mechanical citation verification rejects a citation that was
    in fact correct.
    """
    contents = [
        element(id=f"el_{index:04d}", text=words(200), page=1 + index, bbox=[72, 100, 540, 700])
        for index in range(8)
    ]

    chunks = chunk(contents, tokenizer=tokenizer)

    for produced in chunks:
        pages_in_text = {entry["page"] for entry in produced.pages}
        for element_id in produced.element_ids:
            index = int(element_id.split("#")[0].removeprefix("el_"))
            assert 1 + index in pages_in_text


def test_a_long_paragraph_still_overlaps_across_its_own_split(
    tokenizer: Tokenizer,
) -> None:
    # Each part of a split paragraph is far larger than the overlap budget, so
    # a whole-element overlap would find nothing to carry — at exactly the
    # boundary most likely to cut a sentence in half.
    chunks = chunk([element(text=words(3_000))], tokenizer=tokenizer)

    assert len(chunks) > 1
    assert any(element_id.endswith("#tail") for element_id in chunks[1].element_ids)


def test_ordinals_are_dense_and_in_reading_order(tokenizer: Tokenizer) -> None:
    # They are the upsert key: a gap or a repeat would make a re-run either
    # leave stale rows behind or collide.
    contents = [
        element(id="el_0000", text=words(400)),
        element(id="el_0001", type="table", text="a", markdown="| a |"),
        element(id="el_0002", text=words(2_000)),
        element(id="el_0003", type="table", text="b", markdown="| b |"),
    ]

    chunks = chunk(contents, tokenizer=tokenizer)

    assert [produced.ordinal for produced in chunks] == list(range(len(chunks)))


def test_chunking_the_same_input_twice_produces_the_same_chunks(
    tokenizer: Tokenizer,
) -> None:
    """Determinism is what makes the upsert key stable across a re-delivery."""
    contents = [element(id=f"el_{index:04d}", text=words(200)) for index in range(12)]

    first = chunk(contents, tokenizer=tokenizer)
    second = chunk(contents, tokenizer=tokenizer)

    assert [(c.ordinal, c.text, c.pages) for c in first] == [
        (c.ordinal, c.text, c.pages) for c in second
    ]


# ── Configuration ────────────────────────────────────────────────────────────


def test_the_band_is_configuration_rather_than_a_constant(tokenizer: Tokenizer) -> None:
    contents = [element(id=f"el_{index:04d}", text=words(100)) for index in range(40)]

    small = chunk(contents, tokenizer=tokenizer, target_tokens=300, min_tokens=200, max_tokens=400)
    large = chunk(
        contents, tokenizer=tokenizer, target_tokens=1600, min_tokens=1200, max_tokens=2000
    )

    assert len(small) > len(large)
    assert all(produced.token_count <= 400 for produced in small)
    assert all(produced.token_count <= 2000 for produced in large)


def test_a_zero_overlap_ratio_produces_no_shared_elements(tokenizer: Tokenizer) -> None:
    contents = [element(id=f"el_{index:04d}", text=words(200)) for index in range(12)]

    chunks = chunk(contents, tokenizer=tokenizer, overlap_ratio=0.0)

    seen: set[str] = set()
    for produced in chunks:
        assert not seen & base_ids(produced.element_ids)
        seen.update(base_ids(produced.element_ids))


def test_a_scanned_table_is_never_split_however_large(tokenizer: Tokenizer) -> None:
    """The Phase 12.2 restatement of the invariant, over the shape the OCR tier emits.

    A table reconstructed from a scan reaches the chunker through exactly the
    same `contents` entry a Docling table does, so there is no second code path
    — which is the point of the parse artifact and is worth a test that would
    fail if a `cells` array ever tempted somebody to add one.

    Large on purpose: a forty-row balance sheet is comfortably past the prose
    ceiling, and the rule is that it becomes one oversized chunk rather than
    five that each cite nothing. Half a table answers nothing: the header row
    and the number land in different chunks, and whichever is retrieved is
    missing the other.
    """
    rows = [
        [f"Segment {index}", f"{index},120", f"{index},860", f"{index}%"] for index in range(40)
    ]
    markdown = "\n".join(
        [
            "| Segment | 2023 | 2024 | Change |",
            "| --- | --- | --- | --- |",
            *("| " + " | ".join(row) + " |" for row in rows),
        ]
    )
    scanned_table = element(
        id="el_0001",
        type="table",
        text=markdown,
        markdown=markdown,
        page=1,
        tableJson={
            "numRows": len(rows) + 1,
            "numCols": 4,
            "headers": ["Segment", "2023", "2024", "Change"],
            "rows": rows,
            # What distinguishes a reconstructed table from a parsed one: every
            # cell knows where it was read from on the page.
            "cells": [
                {"rowIndex": 0, "colIndex": 0, "text": "Segment", "bbox": [72, 150, 189, 184]}
            ],
        },
    )

    chunks = chunk(
        [element(id="el_0000", text=words(400), page=1), scanned_table],
        tokenizer=tokenizer,
    )

    table_chunks = [produced for produced in chunks if produced.kind == "table"]
    assert len(table_chunks) == 1
    assert table_chunks[0].element_ids == ["el_0001"]
    assert "Segment 39" in table_chunks[0].text
    assert table_chunks[0].truncated is False
    assert table_chunks[0].table_json is not None
    assert table_chunks[0].table_json["cells"][0]["bbox"] == [72, 150, 189, 184]


# ── Figures (Phase 12.2) ─────────────────────────────────────────────────────
#
# A figure chunk is the Phase 08 bridge for the Phase 12.2 image work: a chart
# is extracted and captioned during the parse, and it becomes retrievable here.
# It reads out of the artifact's `images` rather than its `contents`, which is
# what makes a `reindex` recreate it with no model call and no re-extraction.


def artifact(images: list[dict[str, object]], contents: list[dict[str, object]] | None = None):
    return {"contents": contents or [], "images": images}


def image(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "id": "img_001",
        "page": 4,
        "bbox": [72, 268, 468, 532],
        "width": 792,
        "height": 528,
        "storageKey": "orgs/org_a/documents/doc_a/images/1.png",
        "caption": (
            "A bar chart of revenue by region for 2024. North America accounts for "
            "54 percent, Europe for 28 percent and Asia Pacific for 18 percent."
        ),
    }
    base.update(overrides)
    return base


def chunk_with_figures(
    contents: list[dict[str, object]],
    images: list[dict[str, object]],
    *,
    tokenizer: Tokenizer,
):
    payload = artifact(images, contents)
    return chunk_elements(
        elements_from_contents(payload),
        figures=figure_elements(payload),
        tokenizer=tokenizer,
        options=ChunkingOptions(),
    )


def test_a_captioned_figure_becomes_a_chunk_of_its_own(tokenizer: Tokenizer) -> None:
    """Atomic for the same reason a table is, and the reason is the citation.

    Packed in with the prose around it the passage would still retrieve, and the
    highlight would land on a paragraph beside the figure — a citation that does
    not survive being checked.
    """
    chunks = chunk_with_figures([element(text=words(400), page=4)], [image()], tokenizer=tokenizer)

    figures = [produced for produced in chunks if produced.kind == "figure"]
    assert len(figures) == 1
    assert figures[0].text.startswith("[Figure: ")
    assert "North America" in figures[0].text
    assert figures[0].element_ids == ["img_001"]


def test_a_figure_chunk_points_at_the_figure(tokenizer: Tokenizer) -> None:
    """The rectangle is the figure's own box on its own page.

    Following the citation puts the reader in front of the picture the answer
    came from, which is the whole reason the chunk exists separately.
    """
    chunks = chunk_with_figures([element(page=4)], [image()], tokenizer=tokenizer)

    figure_chunk = next(produced for produced in chunks if produced.kind == "figure")
    assert figure_chunk.pages == [{"page": 4, "bbox": [72.0, 268.0, 468.0, 532.0]}]


def test_an_uncaptioned_figure_produces_no_chunk(tokenizer: Tokenizer) -> None:
    """No vision model, `llm` not set, a provider that failed.

    There is no text to embed and nothing to retrieve on, and a chunk of it
    would be an empty passage that dilutes the index. The figure is still in the
    artifact, still in storage and still locatable — it is simply not
    searchable, which is the honest state rather than a broken one.
    """
    chunks = chunk_with_figures(
        [element(text=words(400))], [image(caption=None)], tokenizer=tokenizer
    )

    assert [produced.kind for produced in chunks] == ["prose"]


def test_a_figure_chunk_lands_next_to_the_page_it_is_on(tokenizer: Tokenizer) -> None:
    """Not at the end of the document, which is where an appended element goes.

    A figure has no position in `contents` at all, so the only honest answer to
    "where in the document is it?" is "just after the last element on its page".
    """
    contents = [
        element(id="el_0000", text=words(400), page=1),
        element(id="el_0001", text=words(400), page=4),
        element(id="el_0002", text=words(400), page=9),
    ]
    chunks = chunk_with_figures(contents, [image(page=4)], tokenizer=tokenizer)

    kinds = [produced.kind for produced in chunks]
    assert kinds.index("figure") not in (0, len(kinds) - 1)


def test_a_docling_picture_caption_stays_in_the_prose_around_it(tokenizer: Tokenizer) -> None:
    """Two different things that happen to share a word.

    A `figure` element in `contents` is a picture's caption *as the document
    printed it* and belongs with the sentences beside it. A figure chunk is a
    vision model's description of the picture itself. The caller keeps them
    apart rather than a rule in the chunker guessing which is which.
    """
    contents = [
        element(id="el_0000", text=words(400)),
        element(
            id="el_0001",
            type="figure",
            text="Figure 1. Revenue by region.",
            markdown="![Figure 1. Revenue by region.]()",
        ),
        element(id="el_0002", text=words(400)),
    ]
    chunks = chunk_with_figures(contents, [], tokenizer=tokenizer)

    assert all(produced.kind == "prose" for produced in chunks)
    assert any("Figure 1. Revenue by region." in produced.text for produced in chunks)


def test_ordinals_stay_dense_across_all_three_streams(tokenizer: Tokenizer) -> None:
    """The upsert key. Dense and stable for a given input, or a re-chunk collides."""
    contents = [
        element(id="el_0000", text=words(400), page=1),
        element(id="el_0001", type="table", text="| a |", markdown="| a |", page=2),
        element(id="el_0002", text=words(400), page=4),
    ]
    chunks = chunk_with_figures(contents, [image(page=4)], tokenizer=tokenizer)

    assert [produced.ordinal for produced in chunks] == list(range(len(chunks)))
    assert {produced.kind for produced in chunks} == {"prose", "table", "figure"}
