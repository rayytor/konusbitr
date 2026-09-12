"""The chunker over the real corpus, and the band it is held to.

`test_chunker.py` tests each rule in isolation from hand-written elements.
This file runs the actual parse over the actual fixtures and measures the thing
the phase is graded on: that chunk token counts land in the 600-900 band. It is
slow — Docling loads a layout model per document — so it is marked `slow`
alongside the parse fixtures and runs in CI on every change.

Two exclusions, both stated precisely rather than chosen to make a number look
good.

*Table chunks are not held to the band.* A table is never split, so its size is
the table's and not a decision the chunker made. Holding it to a prose band
would be grading the fixture, not the chunker.

*A document with less than one chunk's worth of prose is not held to the band.*
`tables-financial.pdf` has about a hundred tokens of prose around its tables and
`rotated-a4.pdf` about two hundred; no chunker can make a 600-token passage out
of either, and the honest output is one small chunk. The condition is a
measurement of the input, not a list of filenames.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

from konusbitr_worker.ai.tokens import Tokenizer
from konusbitr_worker.chunk import Chunk, ChunkingOptions, chunk_elements, elements_from_contents
from konusbitr_worker.settings import Settings
from tests.factories import FakeObjectStore, sha256_of

pytestmark = [pytest.mark.asyncio, pytest.mark.slow]

#: The acceptance criterion: at least this fraction of prose chunks from
#: documents large enough to band are inside it.
BAND_COMPLIANCE = 0.90

#: A model with a real tokenizer, so the band is measured in the units the
#: criterion is written in.
MODEL = "text-embedding-3-large"

CORPUS = [
    "clean-text-10p.pdf",
    "text-50p.pdf",
    "tables-financial.pdf",
    "two-column-paper.pdf",
    "rotated-a4.pdf",
]


@dataclass(frozen=True, slots=True)
class Chunked:
    name: str
    chunks: list[Chunk]
    prose_tokens: int


async def chunk_fixture(name: str, *, settings: Settings, fixtures_dir: Path) -> Chunked:
    """Parse a fixture and chunk it, with storage faked and nothing else."""
    from konusbitr_worker.parse import parse_document

    source = fixtures_dir / name
    artifact = await parse_document(
        store=FakeObjectStore(source=source),
        settings=settings,
        org_id="org_test",
        document_id="doc_fixture",
        storage_key="orgs/org_test/documents/doc_fixture/original.pdf",
        content_hash=sha256_of(source),
        on_stage=None,
    )

    tokenizer = Tokenizer(MODEL)
    contents = artifact.to_json(include_markdown=False)
    elements = elements_from_contents(contents)
    chunks = chunk_elements(elements, tokenizer=tokenizer, options=ChunkingOptions())

    prose_tokens = sum(
        tokenizer.count(element.text) for element in elements if not element.is_table
    )
    return Chunked(name=name, chunks=chunks, prose_tokens=prose_tokens)


@pytest.fixture(scope="module")
def options() -> ChunkingOptions:
    return ChunkingOptions()


async def test_every_fixture_chunks_end_to_end(
    settings: Settings, fixtures_dir: Path, options: ChunkingOptions
) -> None:
    """The headline criterion: every Phase 07 fixture produces chunks.

    And every chunk is locatable, which is the property the whole citation
    machinery rests on.
    """
    for name in CORPUS:
        chunked = await chunk_fixture(name, settings=settings, fixtures_dir=fixtures_dir)

        assert chunked.chunks, f"{name} produced no chunks"
        assert [chunk.ordinal for chunk in chunked.chunks] == list(range(len(chunked.chunks)))

        for chunk in chunked.chunks:
            assert chunk.pages, f"{name} produced a chunk with no location"
            assert chunk.text.strip()
            assert chunk.token_count > 0
            for entry in chunk.pages:
                x0, y0, x1, y1 = entry["bbox"]
                assert entry["page"] >= 1
                assert x0 <= x1 and y0 <= y1


async def test_chunk_token_counts_fall_in_the_band(
    settings: Settings, fixtures_dir: Path, options: ChunkingOptions
) -> None:
    """At least 90% of prose chunks, aggregated over the corpus.

    Aggregated rather than per-document on purpose: the criterion is about the
    chunker's behaviour on a body of text, and a five-chunk fixture can only
    score in twentieths.
    """
    in_band = 0
    counted = 0
    report: list[str] = []

    for name in CORPUS:
        chunked = await chunk_fixture(name, settings=settings, fixtures_dir=fixtures_dir)
        prose = [chunk for chunk in chunked.chunks if chunk.kind == "prose"]

        if chunked.prose_tokens < options.min_tokens:
            # Too little prose for even one banded chunk. Recorded so the
            # exclusion is visible in the output rather than silent.
            report.append(f"{name}: {chunked.prose_tokens} prose tokens, not banded")
            continue

        sizes = [chunk.token_count for chunk in prose]
        inside = [size for size in sizes if options.min_tokens <= size <= options.max_tokens]
        counted += len(sizes)
        in_band += len(inside)
        report.append(f"{name}: {len(inside)}/{len(sizes)} in band {sizes}")

    assert counted > 0
    rate = in_band / counted
    assert rate >= BAND_COMPLIANCE, "\n".join([f"band compliance {rate:.0%}", *report])


async def test_no_chunk_splits_a_table(settings: Settings, fixtures_dir: Path) -> None:
    """Verified over the table-heavy fixture, as the criterion asks.

    Two things have to hold. Every table in the parse becomes exactly one
    chunk, and no table's markdown is spread across two — which is what
    "splits" would mean in practice.
    """
    from konusbitr_worker.parse import parse_document

    source = fixtures_dir / "tables-financial.pdf"
    artifact = await parse_document(
        store=FakeObjectStore(source=source),
        settings=settings,
        org_id="org_test",
        document_id="doc_fixture",
        storage_key="k",
        content_hash=sha256_of(source),
        on_stage=None,
    )

    tables = [element for element in artifact.contents if element.type == "table"]
    assert tables, "the table fixture parsed with no tables at all"

    chunks = chunk_elements(
        elements_from_contents(artifact.to_json(include_markdown=False)),
        tokenizer=Tokenizer(MODEL),
        options=ChunkingOptions(),
    )

    table_chunks = [chunk for chunk in chunks if chunk.kind == "table"]
    assert len(table_chunks) == len(tables)

    # Each table's element id appears in exactly one chunk, so no table was
    # spread across a boundary.
    for table in tables:
        holders = [chunk for chunk in chunks if table.id in chunk.element_ids]
        assert len(holders) == 1
        assert holders[0].kind == "table"
        assert holders[0].truncated is False
        # And the table's data survived alongside its markdown.
        if table.table is not None:
            assert holders[0].to_meta()["tableJson"] == table.table.to_json()


async def test_a_chunk_spanning_a_page_break_names_both_pages(
    settings: Settings, fixtures_dir: Path
) -> None:
    """On a real document, where page breaks fall where the layout puts them."""
    chunked = await chunk_fixture("text-50p.pdf", settings=settings, fixtures_dir=fixtures_dir)

    spanning = [chunk for chunk in chunked.chunks if len(chunk.pages) > 1]
    assert spanning, "a 50-page document produced no chunk crossing a page break"
    for chunk in spanning:
        pages = [entry["page"] for entry in chunk.pages]
        assert pages == sorted(pages)
        assert len(set(pages)) == len(pages)


async def test_every_chunk_says_where_in_the_document_it_came_from(
    settings: Settings, fixtures_dir: Path
) -> None:
    """The point of the breadcrumb, as a property rather than as a column.

    A paragraph about "the increase" is about nothing at all once it has left
    its page, so a retrieved passage has to carry its own context. It arrives
    one of two ways, and which one depends on the document's shape.

    A chunk inside one section gets a `sectionPath` prepended to its text. A
    chunk that merged several sibling sections — which is what the chunker does
    when honouring every boundary would produce fragments — carries those
    sections' *headings* in its body instead, and is labelled only with what
    they genuinely have in common. `text-50p.pdf` is entirely the second case:
    fifty flat `## Section N` headings with no parent, so their common prefix is
    empty and labelling a three-section chunk "Section 1" would be a claim about
    two sections it is not from.

    Either way the context is in the embedded text, which is the thing that
    matters. Neither way is the passage anonymous.
    """
    for name in ("text-50p.pdf", "two-column-paper.pdf"):
        chunked = await chunk_fixture(name, settings=settings, fixtures_dir=fixtures_dir)

        for chunk in chunked.chunks:
            if chunk.section_path:
                assert chunk.text.startswith(f"{chunk.section_path}\n\n")
            else:
                assert "#" in chunk.text, (
                    f"{name} produced an anonymous chunk: no breadcrumb and no "
                    f"heading in its body — {chunk.text[:120]!r}"
                )
