"""Reading a vision model's answer, including every way one can be malformed.

The input here is a *string a language model produced*, so the tests are written
against the shapes providers actually emit rather than against the schema the
prompt asks for. Each one below corresponds to a real deviation: a code fence, a
sentence of preamble, an integer-as-string, a 0-1 coordinate scale, a transposed
axis order.

The line the parser holds is geometry. Shape is negotiable and a box is not: an
element that cannot be resolved to a rectangle on the page is dropped, because
an element that cannot be pointed at cannot be cited.
"""

from __future__ import annotations

import json

import pytest

from konusbitr_worker.parse.artifact import ElementType
from konusbitr_worker.parse.geometry import PageGeometry
from konusbitr_worker.parse.vlm.response import parse_response

#: A Letter page, upright. 612 x 792 points.
LETTER = PageGeometry(page_no=1, raw_width=612.0, raw_height=792.0)


def answer(*elements: dict) -> str:
    return json.dumps({"elements": list(elements)})


def block(**overrides) -> dict:
    """One well-formed element, as the prompt specifies it."""
    return {
        "type": "paragraph",
        "text": "Revenue grew eighteen percent.",
        "markdown": "Revenue grew eighteen percent.",
        # [ymin, xmin, ymax, xmax] on 0-1000: the top-left eighth of the page.
        "bbox_normalized": [100, 50, 200, 500],
        "reading_order": 1,
        **overrides,
    }


class TestShape:
    def test_a_plain_object_parses(self) -> None:
        [element] = parse_response(answer(block()), LETTER)
        assert element.type is ElementType.paragraph
        assert element.text == "Revenue grew eighteen percent."

    def test_a_fenced_object_parses(self) -> None:
        raw = f"```json\n{answer(block())}\n```"
        assert len(parse_response(raw, LETTER)) == 1

    def test_a_preamble_is_stepped_over(self) -> None:
        raw = f"Here is the structured transcription:\n\n{answer(block())}"
        assert len(parse_response(raw, LETTER)) == 1

    def test_a_bare_array_is_read_as_the_elements(self) -> None:
        """A model that skipped the envelope still gave us the content."""
        raw = json.dumps([block()])
        assert len(parse_response(raw, LETTER)) == 1

    def test_prose_with_no_json_yields_nothing(self) -> None:
        assert parse_response("I cannot read this page.", LETTER) == []

    def test_an_empty_page_is_a_legitimate_answer(self) -> None:
        assert parse_response('{"elements": []}', LETTER) == []


class TestGeometry:
    def test_a_box_lands_where_the_fractions_say(self) -> None:
        [element] = parse_response(answer(block()), LETTER)
        # 50/1000 of 612 wide, 100/1000 of 792 tall.
        assert element.bbox.x0 == pytest.approx(30.6)
        assert element.bbox.y0 == pytest.approx(79.2)
        assert element.bbox.x1 == pytest.approx(306.0)
        assert element.bbox.y1 == pytest.approx(158.4)

    def test_a_zero_to_one_scale_is_recognised(self) -> None:
        """Some models answer on 0-1 whatever the prompt says.

        The alternative reading makes the box a thousandth of the page across,
        which is never a real element — so the fraction is the only one of the
        two that can be meant.
        """
        [element] = parse_response(answer(block(bbox_normalized=[0.1, 0.05, 0.2, 0.5])), LETTER)
        assert element.bbox.x0 == pytest.approx(30.6)
        assert element.bbox.y1 == pytest.approx(158.4)

    def test_a_degenerate_box_drops_the_element(self) -> None:
        """A rectangle enclosing nothing cannot be highlighted, so it is not stored."""
        assert parse_response(answer(block(bbox_normalized=[100, 50, 100, 50])), LETTER) == []

    def test_a_missing_box_drops_the_element(self) -> None:
        payload = block()
        del payload["bbox_normalized"]
        assert parse_response(answer(payload), LETTER) == []

    def test_an_alternative_key_is_accepted(self) -> None:
        payload = block()
        del payload["bbox_normalized"]
        payload["bbox_2d"] = [100, 50, 200, 500]
        assert len(parse_response(answer(payload), LETTER)) == 1

    def test_a_rotated_page_is_not_turned_twice(self) -> None:
        """The model saw the page PDFium rendered, and PDFium applied `/Rotate`.

        So the box is already in the visible frame and the rotation table must
        not run. The visible page of a quarter-turned A4 is 842 x 595, and a box
        at the top-left tenth of the *image* is at the top-left tenth of that.
        """
        rotated = PageGeometry(page_no=1, raw_width=595.0, raw_height=842.0, rotation=90)
        [element] = parse_response(answer(block(bbox_normalized=[0, 0, 100, 100])), rotated)
        assert element.bbox.x0 == pytest.approx(0.0)
        assert element.bbox.y0 == pytest.approx(0.0)
        assert element.bbox.x1 == pytest.approx(84.2)
        assert element.bbox.y1 == pytest.approx(59.5)


class TestReadingOrder:
    def test_the_models_order_wins_over_the_array(self) -> None:
        """The one field only this tier can supply, honoured even out of order.

        A model that lists a sidebar first and numbers it third has told us
        something a coordinate sort cannot recover, which is the entire reason
        the page was shown to it.
        """
        elements = parse_response(
            answer(
                block(text="second", reading_order=2, bbox_normalized=[10, 10, 50, 500]),
                block(text="first", reading_order=1, bbox_normalized=[600, 10, 700, 500]),
            ),
            LETTER,
        )
        assert [element.text for element in elements] == ["first", "second"]

    def test_a_missing_order_falls_back_to_the_array(self) -> None:
        payload = block(text="only")
        del payload["reading_order"]
        [element] = parse_response(answer(payload), LETTER)
        assert element.reading_order == 1


class TestTypes:
    def test_a_heading_carries_its_level_and_its_hashes(self) -> None:
        [element] = parse_response(
            answer(block(type="heading", level=3, text="Regional performance")), LETTER
        )
        assert element.type is ElementType.heading
        assert element.level == 3
        assert element.markdown == "### Regional performance"

    def test_a_level_given_as_a_string_is_read(self) -> None:
        [element] = parse_response(answer(block(type="heading", level="2")), LETTER)
        assert element.level == 2

    def test_a_level_beyond_h6_is_clamped(self) -> None:
        [element] = parse_response(answer(block(type="heading", level=99)), LETTER)
        assert element.level == 6

    def test_an_unknown_type_reads_as_a_paragraph(self) -> None:
        """Every downstream consumer already handles a paragraph correctly."""
        [element] = parse_response(answer(block(type="marginalia")), LETTER)
        assert element.type is ElementType.paragraph

    def test_a_callout_reads_as_a_paragraph(self) -> None:
        """The prompt offers the label so a pull quote is named rather than
        mislabelled; the artifact has no such type and a paragraph is the right
        reading of one."""
        [element] = parse_response(answer(block(type="callout")), LETTER)
        assert element.type is ElementType.paragraph

    def test_a_figure_survives_with_no_text(self) -> None:
        """A figure is the one element whose text may legitimately be a
        description rather than a transcription, so an empty one is not dropped
        the way an empty paragraph is."""
        [element] = parse_response(answer(block(type="figure", text="", markdown="")), LETTER)
        assert element.type is ElementType.figure

    def test_an_empty_paragraph_is_dropped(self) -> None:
        assert parse_response(answer(block(text="", markdown="")), LETTER) == []


class TestTables:
    def test_headers_and_rows_become_a_grid_and_markdown(self) -> None:
        [element] = parse_response(
            answer(
                block(
                    type="table",
                    text="",
                    markdown="",
                    headers=["Region", "2024"],
                    rows=[["North", "1,284,567"], ["South", "902,113"]],
                )
            ),
            LETTER,
        )
        assert element.table is not None
        assert element.table.headers == ["Region", "2024"]
        assert element.table.rows == [["North", "1,284,567"], ["South", "902,113"]]
        assert "| Region | 2024 |" in element.markdown
        # A table's text is its markdown, as in both other tiers: the cells are
        # the content, and a flattened concatenation would embed into something
        # that retrieves for every number on the page.
        assert element.text == element.markdown

    def test_a_ragged_row_is_padded_rather_than_dropped(self) -> None:
        [element] = parse_response(
            answer(
                block(
                    type="table",
                    headers=["Region", "2024", "2023"],
                    rows=[["North", "1,284,567"]],
                )
            ),
            LETTER,
        )
        assert element.table is not None
        assert element.table.rows == [["North", "1,284,567", ""]]

    def test_no_cell_boxes_are_invented(self) -> None:
        """A model's per-cell rectangles drift by points, and a citation landing
        one row off a financial table is worse than one that highlights the
        whole table honestly."""
        [element] = parse_response(answer(block(type="table", headers=["A"], rows=[["1"]])), LETTER)
        assert element.table is not None
        assert element.table.cells == []
