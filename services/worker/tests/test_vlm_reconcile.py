"""Hybrid reconciliation: does the text layer actually win?

The acceptance criterion this file exists for is a string-identity claim —
numbers, dates and names in the reconciled artifact match the page's text layer
verbatim — and the honest way to test it is to hand the reconciler a model
answer with a *plausibly wrong digit in it* and assert the digit came back
right. Every case below is built that way: the "VLM" text is a realistic
misreading, and the truth is what the page says.

The doubles here are `TextWord`s constructed directly rather than extracted from
a PDF. That is deliberate — a test whose input is a real document cannot
distinguish "the alignment is wrong" from "the text layer extractor split a word
oddly", and the two have completely different fixes. `test_textlayer.py` makes
the extraction claim; `test_parse_fixtures.py` makes the end-to-end one.
"""

from __future__ import annotations

from konusbitr_worker.parse.artifact import ElementType, TableData
from konusbitr_worker.parse.geometry import BBox
from konusbitr_worker.parse.textlayer import TextWord
from konusbitr_worker.parse.vlm.reconcile import (
    GROUNDING_FLOOR,
    normalize_token,
    reconcile_element,
    reconcile_page,
)
from konusbitr_worker.parse.vlm.response import VlmElement

BLOCK = BBox(x0=50.0, y0=100.0, x1=500.0, y1=200.0)


def words(text: str, *, box: BBox = BLOCK) -> list[TextWord]:
    """A page's text layer, laid out left to right inside one block.

    The boxes only have to fall inside the element's rectangle — the alignment
    is over tokens, not geometry — so they are spread evenly rather than
    measured, which keeps the test about the thing it is testing.
    """
    tokens = text.split()
    if not tokens:
        return []
    step = (box.x1 - box.x0) / len(tokens)
    return [
        TextWord(
            text=token,
            bbox=BBox(
                x0=box.x0 + index * step,
                y0=box.y0 + 1,
                x1=box.x0 + (index + 1) * step,
                y1=box.y1 - 1,
            ),
        )
        for index, token in enumerate(tokens)
    ]


def paragraph(text: str, *, box: BBox = BLOCK) -> VlmElement:
    return VlmElement(
        type=ElementType.paragraph,
        text=text,
        markdown=text,
        bbox=box,
        reading_order=1,
    )


class TestTheExactStringInvariant:
    def test_a_hallucinated_digit_is_corrected(self) -> None:
        """The case the whole tier is grounded for.

        A vision model reads `1,284,567` as `1,234,567` and is entirely
        confident about it. The page is not a matter of opinion.
        """
        element = paragraph("Revenue for the year was 1,234,567 dollars.")
        truth = words("Revenue for the year was 1,284,567 dollars.")

        report = reconcile_element(element, truth)

        assert "1,284,567" in element.text
        assert "1,234,567" not in element.text
        assert element.grounded is True
        assert report.substituted >= 1

    def test_a_misread_date_is_corrected(self) -> None:
        element = paragraph("Executed on 14 March 2019 by the parties.")
        truth = words("Executed on 14 March 2016 by the parties.")

        reconcile_element(element, truth)

        assert element.text == "Executed on 14 March 2016 by the parties."

    def test_a_misspelled_name_is_corrected(self) -> None:
        element = paragraph("between Acme Holdings and Brightwater Ltd")
        truth = words("between Acme Holdings and Brightwalter Ltd")

        reconcile_element(element, truth)

        assert "Brightwalter" in element.text

    def test_a_line_the_model_skipped_is_recovered(self) -> None:
        """Replacement, not patching: the text layer's tokens *are* the block,
        so what the model dropped comes back with them."""
        element = paragraph("The first sentence.")
        truth = words("The first sentence. And the second sentence it missed.")

        report = reconcile_element(element, truth)

        assert element.text == "The first sentence. And the second sentence it missed."
        assert report.missing >= 1

    def test_a_sentence_the_model_invented_is_dropped(self) -> None:
        element = paragraph("The real sentence. A sentence nobody printed.")
        truth = words("The real sentence.")

        report = reconcile_element(element, truth)

        assert element.text == "The real sentence."
        assert report.ungrounded >= 1

    def test_every_token_comes_from_the_page(self) -> None:
        """The criterion stated the way it is actually enforced: after a
        grounded reconciliation, the element's tokens are a subsequence of the
        page's, character for character."""
        element = paragraph("Net income rose to 4.2 million in Q3 2O24")
        truth = words("Net income rose to 4.8 million in Q3 2024")

        reconcile_element(element, truth)

        page_tokens = [word.text for word in truth]
        assert element.text.split() == page_tokens


class TestWhatIsNotCorrected:
    def test_an_element_with_no_text_layer_keeps_the_models_reading(self) -> None:
        """Ordinary on a scan. The model's word alone, and flagged as such."""
        element = paragraph("Whatever the photograph said.")

        report = reconcile_element(element, [])

        assert element.text == "Whatever the photograph said."
        assert element.grounded is False
        assert report.grounded == 0

    def test_a_box_on_the_wrong_block_does_not_swap_one_passage_for_another(
        self,
    ) -> None:
        """Below the grounding floor the *box* is what is wrong, not the text.

        Replacing here would substitute one real passage for another real
        passage — a worse error than an unreconciled one, and far harder to
        notice, because both readings are fluent.
        """
        element = paragraph("The paragraph the model was actually describing.")
        truth = words("Entirely different words about an unrelated subject here.")

        reconcile_element(element, truth)

        assert element.text == "The paragraph the model was actually describing."
        assert element.grounded is False

    def test_a_figure_description_is_left_alone(self) -> None:
        """A figure's text is a description of a picture, which is the one thing
        on a page with no characters to be authoritative about. Reconciling it
        against the axis labels inside its box would replace a sentence about a
        chart with a list of numbers from it."""
        element = VlmElement(
            type=ElementType.figure,
            text="A bar chart comparing revenue across four regions.",
            markdown="![A bar chart comparing revenue across four regions.]()",
            bbox=BLOCK,
            reading_order=1,
        )
        truth = words("North South East West 2024 2023")

        reconcile_element(element, truth)

        assert element.text == "A bar chart comparing revenue across four regions."

    def test_words_outside_the_box_are_not_pulled_in(self) -> None:
        """Centre containment, which is what a two-column page needs: a word
        straddling the gutter belongs to exactly one column."""
        element = paragraph("Left column text here now")
        elsewhere = words("Right column text entirely", box=BBox(520.0, 100.0, 580.0, 200.0))

        reconcile_element(element, elsewhere)

        assert element.grounded is False
        assert element.text == "Left column text here now"


class TestNoise:
    def test_a_ligature_is_not_treated_as_a_hallucination(self) -> None:
        """A text layer writes `ﬁ` as one codepoint and a model writes two.

        Comparing the NFKC-composed forms is what stops the substitution
        machinery from "correcting" thousands of tokens that were already right
        — and inflating the hallucination count, which is a health metric.
        """
        assert normalize_token("ﬁnancial") == normalize_token("financial")

    def test_punctuation_and_case_do_not_count_as_disagreement(self) -> None:
        assert normalize_token("Revenue,") == normalize_token("revenue")

    def test_the_page_spelling_still_wins_even_when_the_forms_compare_equal(
        self,
    ) -> None:
        """Normalization finds the correspondence; it never becomes the output."""
        element = paragraph("financial statements")
        truth = words("ﬁnancial statements")

        reconcile_element(element, truth)

        assert element.text.startswith("ﬁ")


class TestTables:
    def build(self) -> VlmElement:
        table = TableData(
            headers=["Region", "2024"],
            rows=[["North", "1,234,567"], ["South", "902,113"]],
        )
        return VlmElement(
            type=ElementType.table,
            text="",
            markdown="",
            bbox=BLOCK,
            reading_order=1,
            table=table,
        )

    def test_a_cell_is_corrected_without_dissolving_the_grid(self) -> None:
        element = self.build()
        truth = words("Region 2024 North 1,284,567 South 902,113")

        reconcile_element(element, truth)

        assert element.table is not None
        assert element.table.headers == ["Region", "2024"]
        assert element.table.rows == [["North", "1,284,567"], ["South", "902,113"]]
        assert element.grounded is True

    def test_the_markdown_is_rebuilt_from_the_corrected_cells(self) -> None:
        element = self.build()
        truth = words("Region 2024 North 1,284,567 South 902,113")

        reconcile_element(element, truth)

        assert "1,284,567" in element.markdown
        assert element.text == element.markdown

    def test_a_token_the_page_lacks_is_kept_and_counted(self) -> None:
        """Deleting it would shorten a cell a header names. Counted instead, and
        a table with a large `ungrounded` is one a reader should look at."""
        element = self.build()
        truth = words("Region 2024 North 1,284,567 South")

        report = reconcile_element(element, truth)

        assert element.table is not None
        assert len(element.table.rows) == 2
        assert report.ungrounded + report.missing >= 1

    def test_a_grid_the_truth_does_not_support_is_left_alone(self) -> None:
        element = self.build()
        truth = words("Completely unrelated prose about something else entirely")

        reconcile_element(element, truth)

        assert element.grounded is False
        assert element.table is not None
        assert element.table.rows == [["North", "1,234,567"], ["South", "902,113"]]


class TestReport:
    def test_a_page_sums_its_elements(self) -> None:
        elements = [
            paragraph("Revenue was 1,234,567 dollars."),
            paragraph("Costs were 900,000 dollars.", box=BBox(50.0, 300.0, 500.0, 400.0)),
        ]
        truth = [
            *words("Revenue was 1,284,567 dollars."),
            *words("Costs were 900,000 dollars.", box=BBox(50.0, 300.0, 500.0, 400.0)),
        ]

        report = reconcile_page(elements, truth)

        assert report.elements == 2
        assert report.grounded == 2
        assert report.substituted >= 1

    def test_identity_is_one_when_the_model_was_right(self) -> None:
        element = paragraph("Revenue was 1,284,567 dollars.")
        report = reconcile_element(element, words("Revenue was 1,284,567 dollars."))
        assert report.identity == 1.0

    def test_identity_falls_when_it_was_not(self) -> None:
        element = paragraph("Revenue was 1,234,567 dollars.")
        report = reconcile_element(element, words("Revenue was 1,284,567 dollars."))
        assert report.identity < 1.0

    def test_the_grounding_floor_is_where_it_is_documented_to_be(self) -> None:
        """Pinned because it is a judgement, not a derivation: the disagreements
        this tier exists for are dense, and a badly-read page can differ from its
        text layer in a quarter of its tokens and still be the same passage."""
        assert GROUNDING_FLOOR == 0.5
