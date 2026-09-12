"""Normalizing a parsed document into the artifact, without running a parser.

The decisions this covers — which Docling label becomes which element type,
how the heading trail is maintained, what happens to an element with no
provenance, how a table becomes both markdown and JSON — are the ones every
downstream phase depends on, and none of them need a real parse to exercise.
The real parse is covered by the fixture tests, which are slow and need a model
on disk; these run in milliseconds and are where a regression should surface.

The stand-ins below are shaped like Docling's own objects because the
normalizer reads them duck-typed: `.label`, `.prov[].bbox`, `.data.grid`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from konusbitr_worker.parse.artifact import ElementType
from konusbitr_worker.parse.docling_parser import normalize_items
from konusbitr_worker.parse.geometry import PageGeometry

LETTER = PageGeometry(page_no=1, raw_width=612.0, raw_height=792.0)


@dataclass
class FakeOrigin:
    value: str


@dataclass
class FakeBBox:
    l: float  # noqa: E741 - Docling's own field name
    t: float
    r: float
    b: float
    coord_origin: FakeOrigin = field(default_factory=lambda: FakeOrigin("TOPLEFT"))


@dataclass
class FakeProv:
    page_no: int
    bbox: FakeBBox


@dataclass
class FakeLabel:
    value: str


@dataclass
class FakeItem:
    label_value: str
    text: str = ""
    prov: list[FakeProv] = field(default_factory=list)
    level: int | None = None
    data: Any = None

    @property
    def label(self) -> FakeLabel:
        return FakeLabel(self.label_value)


@dataclass
class FakeCell:
    text: str
    column_header: bool = False


@dataclass
class FakeTableData:
    grid: list[list[FakeCell]]


@dataclass
class FakeDocument:
    items: list[FakeItem]

    def iterate_items(self) -> Any:
        return ((item, 0) for item in self.items)


def box(top: float = 72.0, bottom: float = 90.0) -> list[FakeProv]:
    return [FakeProv(page_no=1, bbox=FakeBBox(l=72.0, t=top, r=540.0, b=bottom))]


def normalize(items: list[FakeItem]) -> list[Any]:
    return normalize_items(FakeDocument(items), geometries={1: LETTER})


def test_labels_map_onto_the_seven_artifact_types() -> None:
    elements = normalize(
        [
            FakeItem("section_header", "Revenue", box(), level=2),
            FakeItem("text", "Revenue grew.", box(100, 118)),
            FakeItem("list_item", "First point", box(130, 148)),
            FakeItem("caption", "Figure 1", box(160, 178)),
            FakeItem("footnote", "See appendix.", box(190, 208)),
        ]
    )

    assert [element.type for element in elements] == [
        ElementType.heading,
        ElementType.paragraph,
        ElementType.list,
        ElementType.caption,
        ElementType.footnote,
    ]


def test_an_unknown_label_becomes_a_paragraph() -> None:
    """Docling knows more labels than the artifact does, and will learn more.

    Falling back to `paragraph` means a new Docling release adds text to the
    document rather than silently dropping it — the failure that would be
    caught by nobody, because the parse still succeeds.
    """
    elements = normalize([FakeItem("some_future_label", "Still content.", box())])

    assert [element.type for element in elements] == [ElementType.paragraph]
    assert elements[0].text == "Still content."


def test_running_headers_and_footers_are_dropped() -> None:
    """They repeat on every page, so as chunks they are noise that scores well."""
    elements = normalize(
        [
            FakeItem("page_header", "Confidential", box()),
            FakeItem("text", "The actual content.", box(100, 118)),
            FakeItem("page_footer", "12", box(700, 718)),
        ]
    )

    assert [element.text for element in elements] == ["The actual content."]


def test_ids_are_sequential_and_sort_in_reading_order() -> None:
    elements = normalize([FakeItem("text", f"Paragraph {n}", box()) for n in range(3)])

    assert [element.id for element in elements] == ["el_0000", "el_0001", "el_0002"]
    assert sorted(element.id for element in elements) == [e.id for e in elements]


def test_the_section_path_is_the_trail_above_an_element() -> None:
    """A heading is not inside itself, and a sibling closes what it replaces."""
    elements = normalize(
        [
            FakeItem("title", "Annual Report", box(), level=1),
            FakeItem("section_header", "Financials", box(100, 118), level=2),
            FakeItem("section_header", "Revenue", box(130, 148), level=3),
            FakeItem("text", "Revenue grew 18%.", box(160, 178)),
            FakeItem("section_header", "Costs", box(190, 208), level=3),
            FakeItem("text", "Costs held flat.", box(220, 238)),
        ]
    )

    by_text = {element.text: element for element in elements}
    assert by_text["Annual Report"].section_path == []
    assert by_text["Financials"].section_path == ["Annual Report"]
    assert by_text["Revenue grew 18%."].section_path == ["Annual Report", "Financials", "Revenue"]
    # "Costs" replaced "Revenue" rather than nesting inside it.
    assert by_text["Costs held flat."].section_path == ["Annual Report", "Financials", "Costs"]


def test_an_element_with_no_provenance_is_dropped() -> None:
    """An element nobody can point at cannot be cited, and a guessed box lies."""
    elements = normalize(
        [
            FakeItem("text", "Located.", box()),
            FakeItem("text", "Nowhere in particular.", []),
        ]
    )

    assert [element.text for element in elements] == ["Located."]


def test_every_element_carries_a_page_and_a_box_inside_that_page() -> None:
    elements = normalize([FakeItem("text", "Content.", box())])

    element = elements[0]
    assert element.page == 1
    assert 0 <= element.bbox.x0 < element.bbox.x1 <= LETTER.width
    assert 0 <= element.bbox.y0 < element.bbox.y1 <= LETTER.height


def test_a_heading_renders_its_own_markdown_at_its_own_level() -> None:
    elements = normalize([FakeItem("section_header", "Revenue", box(), level=3)])

    assert elements[0].markdown == "### Revenue"
    assert elements[0].level == 3


def test_a_heading_level_is_clamped_into_h1_to_h6() -> None:
    elements = normalize([FakeItem("section_header", "Deep", box(), level=11)])

    assert elements[0].level == 6


class TestTables:
    """A table is one element, and it is kept twice: as markdown and as JSON."""

    @staticmethod
    def table_item() -> FakeItem:
        grid = [
            [FakeCell("Segment", True), FakeCell("2024", True)],
            [FakeCell("Subscriptions"), FakeCell("5,860")],
            [FakeCell("Services"), FakeCell("2,110")],
        ]
        return FakeItem("table", "", box(), data=FakeTableData(grid=grid))

    def test_a_declared_header_row_becomes_headers(self) -> None:
        elements = normalize([self.table_item()])

        table = elements[0].table
        assert table is not None
        assert table.headers == ["Segment", "2024"]
        assert table.rows == [["Subscriptions", "5,860"], ["Services", "2,110"]]

    def test_the_same_table_is_also_markdown(self) -> None:
        elements = normalize([self.table_item()])

        markdown = elements[0].markdown
        assert "| Segment | 2024 |" in markdown
        assert "| Subscriptions | 5,860 |" in markdown
        # Never split: one element holds the whole table.
        assert len(elements) == 1
        assert elements[0].type is ElementType.table

    def test_a_table_without_a_header_row_does_not_invent_one(self) -> None:
        """Promoting the first row of data would address the wrong cell later."""
        grid = [[FakeCell("4,120"), FakeCell("5,860")], [FakeCell("1,905"), FakeCell("2,110")]]
        elements = normalize([FakeItem("table", "", box(), data=FakeTableData(grid=grid))])

        table = elements[0].table
        assert table is not None
        assert table.headers == []
        assert table.rows == [["4,120", "5,860"], ["1,905", "2,110"]]

    def test_an_empty_table_is_dropped_rather_than_stored_blank(self) -> None:
        elements = normalize([FakeItem("table", "", box(), data=FakeTableData(grid=[]))])

        assert elements == []
