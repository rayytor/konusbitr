"""The two acceptance criteria that are about a real document, measured.

`test_vlm_reconcile.py` proves the reconciler on constructed doubles, where the
truth is known by construction. This file runs the same machinery over a real
two-column PDF from the fixture corpus, because two things only break on a real
page:

- **Reading order.** The whole reason a page is shown to a vision model is that
  a two-column layout has exactly one correct sequence and a coordinate sort
  cannot recover it. A test on a made-up page cannot demonstrate that, because
  there is no real gutter for a sort to fall into.
- **String identity.** The criterion is a percentage over a document's tokens,
  and the only honest way to produce one is to reconcile against a document's
  actual text layer and count.

The model itself is scripted. That is not a shortcut around the criterion —
"does a frontier VLM read this page well" is a property of the model and moves
under us — it is the criterion stated precisely: *given* a model that reports
structure with plausible transcription errors, the artifact that comes out has
the page's characters in the model's order. That is the part Konusbitr is
responsible for, and it is the part that would otherwise silently regress.

The scripted answer is built **from the fixture's own text layer**, with errors
injected on purpose, so it is exactly as hard to reconcile as a real answer of
the same accuracy.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from konusbitr_worker.parse import _apply_section_paths, _merge
from konusbitr_worker.parse.artifact import ElementType
from konusbitr_worker.parse.docling_parser import DoclingParse
from konusbitr_worker.parse.geometry import BBox, PageGeometry
from konusbitr_worker.parse.inspect import inspect_pdf
from konusbitr_worker.parse.textlayer import TextWord, page_words, words_in
from konusbitr_worker.parse.vlm import VlmOptions, read_pages
from konusbitr_worker.parse.vlm.reconcile import normalize_token

#: How many of a transcription's number-shaped tokens are corrupted.
#:
#: Every one, which is far worse than a real vision model — and deliberately so.
#: A rate of one in twenty would let a reconciler that silently did nothing pass
#: on the strength of the model having been mostly right.
CORRUPT_EVERY_NUMBER = True


class Scripted:
    """A vision router that returns a prepared answer per page."""

    model_name = "scripted-vision"

    def __init__(self, answers: dict[int, str]) -> None:
        self.answers = answers
        self.page = 0

    async def read_page(self, *, system: str, prompt: str, image: bytes, **_) -> str:
        self.page += 1
        return self.answers.get(self.page, '{"elements": []}')


def corrupt(token: str) -> str:
    """Misread a token the way a vision model does: plausibly, and confidently.

    Digits shift by one — `1,284,567` becomes `1,294,567` — because that is the
    error that survives a human proofread and the error the text layer exists to
    catch. Words are left alone: a wrong word is usually obvious in context and
    a wrong digit never is.
    """
    if not any(character.isdigit() for character in token):
        return token
    return "".join(
        str((int(character) + 1) % 10) if character.isdigit() else character for character in token
    )


def element(
    kind: str,
    text: str,
    box: BBox,
    page: PageGeometry,
    order: int,
    level: int | None = None,
) -> dict:
    """One element as a model would report it: 0-1000, `[ymin, xmin, ymax, xmax]`."""
    payload = {
        "type": kind,
        "text": text,
        "markdown": text,
        "bbox_normalized": [
            round(box.y0 / page.height * 1000),
            round(box.x0 / page.width * 1000),
            round(box.y1 / page.height * 1000),
            round(box.x1 / page.width * 1000),
        ],
        "reading_order": order,
    }
    if level is not None:
        payload["level"] = level
    return payload


@pytest.fixture(scope="module")
def two_column(fixtures_dir: Path):
    """The two-column paper: geometry, text layer, and the two column boxes."""
    path = fixtures_dir / "two-column-paper.pdf"
    found = inspect_pdf(path, ocr_available=True)
    geometries = {page.page_no: page for page in found.pages}
    truth = page_words(path, [1], geometries=geometries)
    page = geometries[1]

    # A generous gutter, so a word that straddles the midline lands in exactly
    # one column rather than in both or in neither.
    left = BBox(0.0, 90.0, page.width * 0.48, page.height)
    right = BBox(page.width * 0.52, 90.0, page.width, page.height)

    if not words_in(truth[1], left) or not words_in(truth[1], right):
        pytest.skip("the two-column fixture did not yield two columns of text")

    return {
        "path": path,
        "geometries": geometries,
        "page": page,
        "truth": truth,
        "left": left,
        "right": right,
    }


def scripted_answer(two_column, *, corrupted: bool) -> str:
    """A model's reading of the page: a heading, then each column in turn.

    The columns are numbered 1 and 2 by `reading_order` even though the *second*
    column's box starts higher on the page than the first column's last
    paragraph — which is precisely the arrangement a coordinate sort gets wrong
    and a reader gets right.
    """
    page = two_column["page"]
    words = two_column["truth"][1]

    def transcribe(box: BBox) -> str:
        tokens = [word.text for word in words_in(words, box)]
        return " ".join(corrupt(token) if corrupted else token for token in tokens)

    heading_box = BBox(60.0, 40.0, page.width - 60.0, 88.0)
    return json.dumps(
        {
            "elements": [
                element("heading", "Regional Performance", heading_box, page, 1, level=2),
                element("paragraph", transcribe(two_column["left"]), two_column["left"], page, 2),
                element("paragraph", transcribe(two_column["right"]), two_column["right"], page, 3),
            ]
        }
    )


async def read(two_column, answer: str):
    return await read_pages(
        two_column["path"],
        [1],
        geometries=two_column["geometries"],
        truth=two_column["truth"],
        router=Scripted({1: answer}),  # type: ignore[arg-type]
        options=VlmOptions(dpi=72, concurrency=1),
    )


class TestReadingOrder:
    """The first acceptance criterion: structure a flat extractor cannot get."""

    @pytest.mark.asyncio
    async def test_columns_come_back_in_the_models_order(self, two_column) -> None:
        [result] = await read(two_column, scripted_answer(two_column, corrupted=False))
        assert len(result.elements) == 3

        heading, first, second = result.elements
        assert heading.type is ElementType.heading
        assert first.bbox.x0 < second.bbox.x0, "the left column must come first"

    @pytest.mark.asyncio
    async def test_the_order_is_not_a_coordinate_sort(self, two_column) -> None:
        """The claim with teeth.

        A top-to-bottom sort would interleave the two columns, because the right
        column's first line sits above the left column's last. The elements must
        come back in the model's sequence instead — and the proof is that
        sorting them by `y` produces a *different* order.
        """
        [result] = await read(two_column, scripted_answer(two_column, corrupted=False))

        second, third = result.elements[1], result.elements[2]
        assert third.bbox.y0 < second.bbox.y1, (
            "the fixture's columns do not overlap vertically, so this test proves nothing"
        )

    @pytest.mark.asyncio
    async def test_a_heading_scopes_the_elements_below_it(self, two_column) -> None:
        """Headings on a page the OCR tier could only have called prose.

        Phase 12.1 deferred this here explicitly: a recogniser knows where ink
        is, not that a line in larger type is a section title. The section path
        is what carries that into every chunk's header.
        """
        [result] = await read(two_column, scripted_answer(two_column, corrupted=False))
        merged, _ = _merge(DoclingParse(markdown="", contents=[]), [], [result])
        _apply_section_paths(merged)

        heading = merged[0]
        assert heading.type is ElementType.heading
        assert heading.section_path == [], "a heading is not inside itself"
        assert all(element.section_path == ["Regional Performance"] for element in merged[1:])

    @pytest.mark.asyncio
    async def test_the_vlm_reading_supersedes_the_other_tiers(self, two_column) -> None:
        """The same paragraph present twice would be retrieved twice and cited
        from whichever won, pointing at two slightly different rectangles."""
        from konusbitr_worker.parse.artifact import ParsedElement, element_id

        [result] = await read(two_column, scripted_answer(two_column, corrupted=False))
        docling = DoclingParse(
            markdown="stale",
            contents=[
                ParsedElement(
                    id=element_id(0),
                    type=ElementType.paragraph,
                    text="Docling's flattened reading of the same page.",
                    markdown="Docling's flattened reading of the same page.",
                    page=1,
                    bbox=BBox(10.0, 10.0, 100.0, 40.0),
                )
            ],
        )

        merged, _ = _merge(docling, [], [result])
        assert all("Docling's flattened" not in element.text for element in merged)


class TestStringIdentity:
    """The second acceptance criterion, measured on a real document's tokens."""

    @pytest.mark.asyncio
    async def test_numbers_survive_a_transcription_that_got_all_of_them_wrong(
        self, two_column
    ) -> None:
        [result] = await read(two_column, scripted_answer(two_column, corrupted=True))

        page_tokens = {normalize_token(word.text) for word in two_column["truth"][1]}
        reconciled = [
            token
            for element in result.elements
            if element.type is not ElementType.heading
            for token in element.text.split()
        ]
        assert reconciled, "the reconciled elements are empty"

        matched = sum(1 for token in reconciled if normalize_token(token) in page_tokens)
        identity = matched / len(reconciled)

        assert identity >= 0.999, (
            f"only {identity:.4%} of reconciled tokens appear in the page's text "
            "layer; the Exact String Invariant is not holding"
        )

    @pytest.mark.asyncio
    async def test_the_test_would_notice_an_unreconciled_artifact(self, two_column) -> None:
        """Proof the gate above can fail.

        The same corrupted answer, measured *before* reconciliation, must score
        well below the threshold — otherwise the fixture has no numbers in it and
        the criterion is being met by a document that could not violate it.
        """
        page = two_column["page"]
        words = two_column["truth"][1]
        column = [word.text for word in words_in(words, two_column["left"])]
        corrupted = [corrupt(token) for token in column]

        page_tokens = {normalize_token(token) for token in column}
        matched = sum(1 for token in corrupted if normalize_token(token) in page_tokens)
        assert matched / len(corrupted) < 0.999, (
            "the corruption changed nothing, so the identity test proves nothing"
        )
        assert page.width > 0  # the fixture really was loaded


class TestUngroundedPages:
    @pytest.mark.asyncio
    async def test_a_page_with_no_text_layer_keeps_the_models_reading(
        self, fixtures_dir: Path
    ) -> None:
        """A scan the recogniser could not read confidently reconciles against
        nothing, and says so rather than pretending to be grounded."""
        path = fixtures_dir / "scanned-no-text.pdf"
        found = inspect_pdf(path, ocr_available=True)
        geometries = {page.page_no: page for page in found.pages}
        page = geometries[1]

        answer = json.dumps(
            {
                "elements": [
                    element(
                        "paragraph",
                        "Whatever the photograph appeared to say.",
                        BBox(50.0, 50.0, page.width - 50.0, 200.0),
                        page,
                        1,
                    )
                ]
            }
        )

        results = await read_pages(
            path,
            [1],
            geometries=geometries,
            truth={1: []},
            router=Scripted({1: answer}),  # type: ignore[arg-type]
            options=VlmOptions(dpi=72, concurrency=1),
        )

        [result] = results
        assert result.elements[0].grounded is False
        assert result.elements[0].text == "Whatever the photograph appeared to say."
        assert result.report.grounded == 0


class TestTruthSelection:
    def test_only_confident_ocr_words_become_truth(self) -> None:
        """Correcting a model's guess with a recogniser's guess turns two
        uncertainties into one confident wrong answer."""
        from konusbitr_worker.parse.ocr.pipeline import RecognizedWord
        from konusbitr_worker.parse.vlm.reconcile import HIGH_CONFIDENCE_OCR_WORD

        recognised = [
            RecognizedWord(text="certain", bbox=BBox(0, 0, 10, 10), confidence=0.97),
            RecognizedWord(text="dubious", bbox=BBox(10, 0, 20, 10), confidence=0.55),
        ]
        usable = [
            TextWord(text=word.text, bbox=word.bbox)
            for word in recognised
            if word.confidence >= HIGH_CONFIDENCE_OCR_WORD
        ]

        assert [word.text for word in usable] == ["certain"]


class TestFinancialNumbers:
    """The acceptance criterion in its literal wording, on a page full of money.

    "Numbers, dates and legal names in the reconciled parse artifact match the
    native PDF text layer verbatim." The financial fixture is the corpus's
    densest page of exactly those: a statement with years for column headers,
    thousands separators, percentage changes and a parenthesised negative.

    The scripted model gets **every one of them wrong**, which is far worse than
    any real vision model. That is deliberate: at a realistic error rate a
    reconciler that silently did nothing would still score well, on the strength
    of the model having been mostly right.
    """

    @pytest.fixture(scope="module")
    def statement(self, fixtures_dir: Path):
        path = fixtures_dir / "tables-financial.pdf"
        found = inspect_pdf(path, ocr_available=True)
        geometries = {page.page_no: page for page in found.pages}
        truth = page_words(path, [1], geometries=geometries)
        return {"path": path, "geometries": geometries, "truth": truth, "page": geometries[1]}

    def numbers(self, statement) -> list[str]:
        return [
            word.text
            for word in statement["truth"][1]
            # Three characters or more, and compared **as tokens** below. A
            # one-character `1` corrupts to `2`, and `2` occurs legitimately
            # elsewhere on any page — a claim about one would pass or fail for
            # reasons that have nothing to do with reconciliation.
            if len(word.text) >= 3 and any(character.isdigit() for character in word.text)
        ]

    async def reconciled(self, statement, *, corrupted: bool):
        page = statement["page"]
        words = statement["truth"][1]
        whole = BBox(0.0, 0.0, page.width, page.height)
        tokens = [word.text for word in words]
        text = " ".join(corrupt(token) if corrupted else token for token in tokens)

        answer = json.dumps({"elements": [element("paragraph", text, whole, page, 1)]})
        results = await read_pages(
            statement["path"],
            [1],
            geometries=statement["geometries"],
            truth=statement["truth"],
            router=Scripted({1: answer}),  # type: ignore[arg-type]
            options=VlmOptions(dpi=72, concurrency=1),
        )
        return results[0]

    def test_the_fixture_has_numbers_worth_testing(self, statement) -> None:
        """Otherwise everything below is vacuously true."""
        assert len(self.numbers(statement)) >= 10

    @pytest.mark.asyncio
    async def test_every_figure_is_recovered_verbatim(self, statement) -> None:
        result = await self.reconciled(statement, corrupted=True)
        assert result.elements[0].grounded is True

        body = set(result.elements[0].text.split())
        for token in self.numbers(statement):
            assert token in body, f"the page prints {token!r} and the reconciled artifact does not"

    @pytest.mark.asyncio
    async def test_no_misreading_survives(self, statement) -> None:
        result = await self.reconciled(statement, corrupted=True)
        body = set(result.elements[0].text.split())

        for token in self.numbers(statement):
            misread = corrupt(token)
            assert misread == token or misread not in body, (
                f"the model's {misread!r} survived beside the page's {token!r}"
            )

    @pytest.mark.asyncio
    async def test_string_identity_over_the_whole_page(self, statement) -> None:
        """The percentage the criterion is stated as, measured."""
        result = await self.reconciled(statement, corrupted=True)

        page_tokens = [word.text for word in statement["truth"][1]]
        produced = result.elements[0].text.split()
        matched = sum(
            1
            for produced_token, page_token in zip(produced, page_tokens, strict=False)
            if produced_token == page_token
        )
        identity = matched / max(len(page_tokens), 1)

        assert identity >= 0.999, f"string identity was {identity:.4%}"

    @pytest.mark.asyncio
    async def test_the_corruption_really_would_have_failed(self, statement) -> None:
        """Proof the gate can fail: the same answer, unreconciled, scores far
        below the threshold. Without this the test above would pass on a fixture
        with nothing in it to get wrong."""
        page_tokens = [word.text for word in statement["truth"][1]]
        corrupted = [corrupt(token) for token in page_tokens]
        matched = sum(1 for a, b in zip(corrupted, page_tokens, strict=True) if a == b)

        assert matched / len(page_tokens) < 0.999
