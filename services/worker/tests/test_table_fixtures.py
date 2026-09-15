"""A scanned financial statement, end to end, as a table rather than as prose.

`test_ocr_tables.py` tests the grid detector against bitmaps drawn by hand, where
the answer is known by construction. This runs the whole pipeline over
`scanned-table.pdf` — a real raster of a real ruled table, degraded the way a
scanner degrades one — and asserts the thing the phase actually promises: the
page comes back as a `table` element carrying valid markdown and a complete
`tableJson`, and the numbers are still attached to the rows they belong to.

That last part is the whole point. A scanned balance sheet flattened into prose
keeps every number and loses every association, and a chat over it then picks a
figure out of a row of figures with nothing to bind it to — which retrieves
beautifully and answers wrongly.

Slow, and marked `slow`: a 300 DPI rasterisation and a recognition pass per page.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from konusbitr_worker.parse import parse_document
from konusbitr_worker.parse.artifact import ElementType, ParseArtifact, ParsedElement
from konusbitr_worker.settings import Settings
from tests.factories import FakeObjectStore, sha256_of

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "fixtures"))

from fixture_text import TABLE_HEADERS, TABLE_ROWS

pytestmark = [pytest.mark.asyncio, pytest.mark.slow]


async def parse(fixtures_dir: Path, settings: Settings) -> ParseArtifact:
    source = fixtures_dir / "scanned-table.pdf"
    return await parse_document(
        store=FakeObjectStore(source=source),
        settings=settings,
        org_id="org_test",
        document_id="doc_fixture",
        storage_key="orgs/org_test/documents/doc_fixture/original.pdf",
        content_hash=sha256_of(source),
    )


def tables(artifact: ParseArtifact, page: int) -> list[ParsedElement]:
    return [
        element
        for element in artifact.contents
        if element.page == page and element.type is ElementType.table
    ]


async def test_a_scanned_table_comes_back_as_a_table(
    settings: Settings, fixtures_dir: Path
) -> None:
    """The headline acceptance criterion, as one test."""
    artifact = await parse(fixtures_dir, settings)
    found = tables(artifact, 1)

    assert len(found) == 1
    assert found[0].table is not None
    assert found[0].markdown.startswith("|")


async def test_the_header_row_names_the_columns(settings: Settings, fixtures_dir: Path) -> None:
    """Headers in `headers`, data in `rows`, and the two not confused.

    A scan carries no declared header — the bold type and the shading are gone
    by the time the page is binarised — so this is the heuristic in
    `_looks_like_a_header` doing its job on a table whose column headings are
    years, which is the case the obvious rule gets wrong.
    """
    artifact = await parse(fixtures_dir, settings)
    table = tables(artifact, 1)[0].table

    assert table is not None
    assert table.headers == TABLE_HEADERS
    assert len(table.rows) == len(TABLE_ROWS)


async def test_every_figure_is_still_attached_to_its_row(
    settings: Settings, fixtures_dir: Path
) -> None:
    """The association is the content of a financial table.

    Flattened into prose, the numbers survive and this does not — and a chat
    over that page answers "what were services in 2024?" by picking a figure out
    of a row of figures with nothing to bind it to.
    """
    artifact = await parse(fixtures_dir, settings)
    table = tables(artifact, 1)[0].table

    assert table is not None
    assert table.rows == TABLE_ROWS


async def test_the_table_reports_its_own_dimensions(settings: Settings, fixtures_dir: Path) -> None:
    artifact = await parse(fixtures_dir, settings)
    table = tables(artifact, 1)[0].table

    assert table is not None
    # The header row counts, which is what `rowIndex` counts in.
    assert (table.num_rows, table.num_cols) == (len(TABLE_ROWS) + 1, len(TABLE_HEADERS))


async def test_every_cell_is_located_on_the_page(settings: Settings, fixtures_dir: Path) -> None:
    """Cell boxes are what make a citation land on the number rather than the table.

    Each one must sit inside the table's own rectangle, in the one coordinate
    convention — which is the assertion that catches a cell box left in pixels
    or left in the deskewed frame.
    """
    artifact = await parse(fixtures_dir, settings)
    element = tables(artifact, 1)[0]
    table = element.table

    assert table is not None
    assert len(table.cells) == (len(TABLE_ROWS) + 1) * len(TABLE_HEADERS)
    for cell in table.cells:
        assert cell.bbox is not None
        assert element.bbox.x0 - 1 <= cell.bbox.x0 <= cell.bbox.x1 <= element.bbox.x1 + 1
        assert element.bbox.y0 - 1 <= cell.bbox.y0 <= cell.bbox.y1 <= element.bbox.y1 + 1


async def test_a_merged_header_cell_is_one_cell_with_a_span(
    settings: Settings, fixtures_dir: Path
) -> None:
    """The second page's header spans three columns, and the rule beneath it is absent.

    That absence is the only evidence a merge happened — it is what a reader
    uses and it needs no model — so a pipeline that read the grid without it
    would report four header cells where the page has two.
    """
    artifact = await parse(fixtures_dir, settings)
    table = tables(artifact, 2)[0].table

    assert table is not None
    spanning = [cell for cell in table.cells if cell.col_span > 1]
    assert len(spanning) == 1
    assert spanning[0].col_span == 3
    assert spanning[0].text == "Employees"


async def test_the_table_is_not_also_read_as_prose(settings: Settings, fixtures_dir: Path) -> None:
    """Partitioned, not copied.

    A number in both a table element and a paragraph is retrieved twice and
    cited from whichever won, and the two citations point at different
    rectangles. The page's only prose is its title.
    """
    artifact = await parse(fixtures_dir, settings)
    prose = [
        element
        for element in artifact.contents
        if element.page == 1 and element.type is not ElementType.table
    ]

    assert [element.text for element in prose] == ["Annual Financial Summary"]


async def test_the_table_survives_into_the_markdown_a_model_reads(
    settings: Settings, fixtures_dir: Path
) -> None:
    """Pipe-table markdown, because that is what an LLM reads a table as.

    The JSON is for Phase 13's `extract`; this is for the answer.
    """
    artifact = await parse(fixtures_dir, settings)

    assert "| Segment | 2023 | 2024 | Change |" in artifact.markdown
    assert "| Subscriptions | 4,120 | 5,860 | 42% |" in artifact.markdown
