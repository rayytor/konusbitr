"""Rebuilding lines and paragraphs from a bag of word boxes.

An OCR engine returns tokens with no structure. What
:mod:`konusbitr_worker.parse.ocr.layout` does with them decides whether a
scanned two-column paper becomes two readable columns or one column of
nonsense, so the cases here are the ones where the geometry is genuinely
ambiguous rather than the ones where any implementation would work.

Pure arithmetic over constructed boxes: no engine, no bitmap, no PDF. That is
deliberate, and it is the same reason `test_geometry.py` is written that way —
an assertion against hand-computed expectations catches a bug that an assertion
against whatever the recogniser happened to emit records instead.
"""

from __future__ import annotations

from konusbitr_worker.parse.ocr.engines import OcrResult, OcrWord
from konusbitr_worker.parse.ocr.layout import group_blocks, group_lines


def word(text: str, x0: float, y0: float, x1: float, y1: float, confidence: float = 0.9) -> OcrWord:
    return OcrWord(text=text, box=(x0, y0, x1, y1), confidence=confidence)


def line_at(y: float, texts: list[str], *, x: float = 0.0, height: float = 20.0) -> list[OcrWord]:
    """A row of words, each 60 wide with a 10 gap, starting at `x`."""
    return [
        word(text, x + index * 70, y, x + index * 70 + 60, y + height)
        for index, text in enumerate(texts)
    ]


class TestLines:
    def test_words_on_one_row_become_one_line(self) -> None:
        lines = group_lines(line_at(100, ["The", "quick", "brown"]))

        assert len(lines) == 1
        assert lines[0].text == "The quick brown"

    def test_words_on_separate_rows_stay_separate(self) -> None:
        lines = group_lines([*line_at(100, ["first"]), *line_at(140, ["second"])])

        assert [line.text for line in lines] == ["first", "second"]

    def test_a_line_is_decided_by_overlap_not_by_an_absolute_tolerance(self) -> None:
        """The same page carries 8pt footnotes and 24pt headings.

        Any pixel tolerance that groups the headings correctly splits the
        footnotes, and vice versa — which is why the rule is a fraction of the
        shorter box's own height.
        """
        big = word("HEADING", 0, 100, 200, 148)
        # A small word sitting inside the heading's vertical span, as a
        # superscript or a mid-line subscript would.
        small = word("2", 210, 112, 222, 128)

        assert len(group_lines([big, small])) == 1

    def test_words_are_ordered_left_to_right_within_a_line(self) -> None:
        scrambled = [
            word("third", 140, 100, 200, 120),
            word("first", 0, 100, 60, 120),
            word("second", 70, 100, 130, 120),
        ]

        assert group_lines(scrambled)[0].text == "first second third"

    def test_lines_are_ordered_top_to_bottom_whatever_order_they_arrive_in(self) -> None:
        arriving_backwards = [*line_at(300, ["last"]), *line_at(100, ["first"])]

        assert [line.text for line in group_lines(arriving_backwards)] == ["first", "last"]


class TestBlocks:
    def test_closely_spaced_lines_become_one_paragraph(self) -> None:
        lines = group_lines(
            [
                *line_at(100, ["one", "two", "three"]),
                *line_at(124, ["four", "five", "six"]),
                *line_at(148, ["seven", "eight"]),
            ]
        )

        blocks = group_blocks(lines)
        assert len(blocks) == 1
        assert blocks[0].text == "one two three four five six seven eight"

    def test_a_paragraph_break_starts_a_new_block(self) -> None:
        lines = group_lines(
            [
                *line_at(100, ["opening"]),
                # Well past `PARAGRAPH_GAP_RATIO` of the line height.
                *line_at(220, ["closing"]),
            ]
        )

        assert [block.text for block in group_blocks(lines)] == ["opening", "closing"]

    def test_two_columns_are_not_read_across_the_gutter(self) -> None:
        """The failure this test exists for produces individually plausible prose.

        A left column and a right column at the same vertical positions are
        adjacent in every sort that ignores x, and the result reads as sentences
        that were never written. The horizontal-overlap rule is what separates
        them, and it is the reason blocks are not simply "lines that are close
        together".
        """
        left = [
            *line_at(100, ["left"], x=0),
            *line_at(124, ["column"], x=0),
        ]
        right = [
            *line_at(100, ["right"], x=400),
            *line_at(124, ["column"], x=400),
        ]

        blocks = group_blocks(group_lines([*left, *right]))
        texts = {block.text for block in blocks}
        assert texts == {"left column", "right column"}

    def test_a_word_broken_across_a_line_is_rejoined(self) -> None:
        """Otherwise the quote verifier cannot find the phrase the model quoted."""
        lines = group_lines(
            [
                *line_at(100, ["the", "photo-"]),
                *line_at(124, ["graphic", "record"]),
            ]
        )

        assert group_blocks(lines)[0].text == "the photographic record"

    def test_a_genuine_hyphenated_compound_survives(self) -> None:
        """`state-` / `Level` is two words; `photo-` / `graphic` is one.

        Capitalisation is the only signal available without a dictionary, and
        joining across it would corrupt text that was correct.
        """
        lines = group_lines(
            [
                *line_at(100, ["a", "state-"]),
                *line_at(124, ["Level", "finding"]),
            ]
        )

        assert group_blocks(lines)[0].text == "a state- Level finding"


class TestConfidence:
    def test_a_page_with_nothing_on_it_is_zero_not_one(self) -> None:
        """Recognising nothing is the worst outcome, and must trip the fallback."""
        assert OcrResult().confidence == 0.0

    def test_confidence_is_weighted_by_how_much_text_backs_it(self) -> None:
        """A misread stamp in the corner must not outvote a page of clean prose."""
        page = OcrResult(
            words=[
                word("a page of entirely legible body text", 0, 0, 400, 20, confidence=0.98),
                word("?", 500, 700, 510, 720, confidence=0.10),
            ]
        )

        assert page.confidence > 0.95

    def test_whitespace_only_tokens_do_not_dilute_the_score(self) -> None:
        page = OcrResult(
            words=[
                word("legible", 0, 0, 100, 20, confidence=1.0),
                word("   ", 110, 0, 140, 20, confidence=0.0),
            ]
        )

        assert page.confidence == 1.0


# ── Reading direction (Phase 12.2) ───────────────────────────────────────────


def rtl_line_at(y: float, texts: list[str], *, right: float = 500.0) -> list[OcrWord]:
    """A row of words laid out right to left, `texts` in *logical* order.

    The first word of the sentence is the rightmost box on the page, which is
    how a right-to-left line is actually placed — and is exactly what a sort by
    ascending x destroys.
    """
    return [
        word(text, right - (index + 1) * 70, y, right - index * 70 - 10, y + 20.0)
        for index, text in enumerate(texts)
    ]


class TestReadingDirection:
    def test_a_right_to_left_line_comes_back_in_logical_order(self) -> None:
        """The sentence a reader reads, not the boxes left to right.

        Getting this wrong does not produce garbage, which is what makes it
        dangerous: it produces a sentence with its words reversed, which reads
        as a recognition failure, embeds as nonsense, and can never be matched
        by the quote verifier against anything a model quotes back.
        """
        lines = group_lines(rtl_line_at(100, ["تم", "توقيع", "العقد"]))

        assert [line.text for line in lines] == ["تم توقيع العقد"]

    def test_direction_is_taken_from_the_line_and_not_from_the_document(self) -> None:
        """The regression a document-level flag caused.

        With `langList=['ar']` the Turkish page of a mixed filing came back as
        `Belge Taranmis Turkce` — every word recognised correctly and every
        sentence backwards. A Latin page inside an Arabic document reads left to
        right, and the only thing that knows so is the line itself.
        """
        latin = group_lines(line_at(100, ["Konusbitr", "Scanned", "Fixture"]), rtl=True)
        arabic = group_lines(rtl_line_at(200, ["تم", "توقيع", "العقد"]), rtl=False)

        assert [line.text for line in latin] == ["Konusbitr Scanned Fixture"]
        assert [line.text for line in arabic] == ["تم توقيع العقد"]

    def test_a_line_of_digits_takes_the_document_direction(self) -> None:
        """Numbers and punctuation have no direction of their own.

        A row of figures inside an Arabic table belongs to that table's
        direction, and the language plan is the only thing left that knows it.
        """
        digits = ["4,120", "5,860", "42%"]

        assert group_lines(rtl_line_at(100, digits), rtl=True)[0].text == "4,120 5,860 42%"
        assert group_lines(line_at(100, digits), rtl=False)[0].text == "4,120 5,860 42%"

    def test_a_mixed_line_follows_its_majority(self) -> None:
        """An Arabic sentence naming an English product is Arabic.

        A majority vote rather than Unicode's first-strong rule, because
        first-strong reads a storage order and the storage order of a line
        assembled out of separate word boxes is not a property of the page.
        """
        line = group_lines(rtl_line_at(100, ["شروط", "العقد", "ACME", "بين", "الطرفين"]))[0]

        assert line.rtl is True
        assert line.text.startswith("شروط العقد")

    def test_a_right_to_left_line_is_still_split_at_a_gutter(self) -> None:
        """The gap is walked in the direction the line is read.

        Measured the other way, every line splits at its first space and none at
        its gutter — which is the same bug the left-to-right case has, mirrored.
        """
        right_column = rtl_line_at(100, ["شروط", "العقد"], right=900.0)
        left_column = rtl_line_at(100, ["بين", "الطرفين"], right=400.0)

        lines = group_lines([*right_column, *left_column], rtl=True)

        assert [line.text for line in lines] == ["شروط العقد", "بين الطرفين"]

    def test_a_right_to_left_page_reads_its_rightmost_column_first(self) -> None:
        """Two columns, read down the right one and then down the left."""
        blocks = group_blocks(
            group_lines(
                [
                    *rtl_line_at(100, ["شروط", "العقد"], right=900.0),
                    *rtl_line_at(130, ["بين", "الطرفين"], right=900.0),
                    *rtl_line_at(100, ["المبلغ", "الإجمالي"], right=400.0),
                    *rtl_line_at(130, ["أربعة", "آلاف"], right=400.0),
                ],
                rtl=True,
            ),
            rtl=True,
        )

        assert [block.text for block in blocks] == [
            "شروط العقد بين الطرفين",
            "المبلغ الإجمالي أربعة آلاف",
        ]
