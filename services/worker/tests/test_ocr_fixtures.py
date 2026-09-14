"""The real recogniser over the real scanned corpus.

Everything in `test_ocr_layout.py`, `test_ocr_preprocess.py` and
`test_ocr_engines.py` tests a decision in isolation. This file tests the claim:
that a scanned PDF goes in and readable text plus locatable boxes come out.

The fixtures make that assertable rather than merely recordable. Each one is a
raster of text that `fixtures/generate.py` typeset, so this file knows exactly
what the page says and can assert the words back — the alternative, comparing
against whatever the recogniser emitted last time, measures nothing except
whether the recogniser changed.

Slow, and marked `slow`: three ONNX graphs and a 300 DPI rasterisation per page.
CI runs it; `-m "not slow"` is the loop to iterate in.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from konusbitr_worker.parse import parse_document
from konusbitr_worker.parse.artifact import PageTier, ParseArtifact
from konusbitr_worker.settings import Settings
from tests.factories import FakeObjectStore, sha256_of

pytestmark = [pytest.mark.asyncio, pytest.mark.slow]

#: Words `fixtures/generate.py` typesets onto every scanned fixture page. A
#: recogniser that reads the page at all reads these.
#:
#: The third one is here because it was once *silently lost*. PP-OCR's angle
#: classifier decided this single line of ordinary Helvetica was upside down,
#: flipped it, recognised the result as noise, and dropped it below
#: `text_score` — leaving a page that was missing a line and reporting 0.99
#: confidence about the lines it had kept. Nothing in the text or the
#: confidence gave it away. See `RapidOcrOptions.classify_orientation`.
KNOWN_PHRASES = (
    "Konusbitr Scanned Fixture",
    "The quick brown fox jumps over the lazy dog",
    "Every bounding box is stored in PDF user-space points",
)


async def parse(
    name: str, *, settings: Settings, fixtures_dir: Path
) -> tuple[ParseArtifact, FakeObjectStore]:
    source = fixtures_dir / name
    store = FakeObjectStore(source=source)
    artifact = await parse_document(
        store=store,
        settings=settings,
        org_id="org_test",
        document_id="doc_fixture",
        storage_key="orgs/org_test/documents/doc_fixture/original.pdf",
        content_hash=sha256_of(source),
        on_stage=None,
    )
    return artifact, store


def squashed(text: str) -> str:
    """Case- and space-insensitive, so a rewrap or a stray space is not a failure."""
    return " ".join(text.split()).lower()


# ── Clean scanned Letter ─────────────────────────────────────────────────────


async def test_a_wholly_scanned_pdf_parses_instead_of_being_refused(
    settings: Settings, fixtures_dir: Path
) -> None:
    """The headline acceptance criterion, as one test.

    Phase 07 failed this document with `needs_ocr`. It now comes back with
    markdown, with an element on every page, and with every page tiered `ocr`.
    """
    artifact, _store = await parse(
        "scanned-letter.pdf", settings=settings, fixtures_dir=fixtures_dir
    )

    assert artifact.page_count == 3
    assert artifact.contents, "a scanned PDF must produce elements"
    assert {page.tier for page in artifact.pages} == {PageTier.ocr}

    markdown = squashed(artifact.markdown)
    for phrase in KNOWN_PHRASES:
        assert squashed(phrase) in markdown

    assert {element.page for element in artifact.contents} == {1, 2, 3}


async def test_recognised_boxes_land_on_the_words_they_belong_to(
    settings: Settings, fixtures_dir: Path
) -> None:
    """The inverted-axis assertion, for the OCR tier.

    `generate.py` puts the title 96 points from the *top* of the page at a
    72-point left margin, so a correct box has a small `y0` and an `x0` near 72.
    A flipped y axis produces boxes that are individually plausible — inside the
    page, the right size — and every one of them on the wrong line.
    """
    artifact, _store = await parse(
        "scanned-letter.pdf", settings=settings, fixtures_dir=fixtures_dir
    )

    title = next(
        element
        for element in artifact.contents
        if element.page == 1 and "Scanned Fixture" in element.text
    )

    assert title.bbox.y0 < 140, "the title is near the top of the page"
    assert 60 < title.bbox.x0 < 90, "the title starts at the 72-point margin"
    assert title.bbox.x1 < 612 and title.bbox.y1 < 792


async def test_every_recognised_element_is_inside_its_own_page(
    settings: Settings, fixtures_dir: Path
) -> None:
    artifact, _store = await parse(
        "scanned-letter.pdf", settings=settings, fixtures_dir=fixtures_dir
    )
    by_page = {page.page_no: page for page in artifact.pages}

    for element in artifact.contents:
        page = by_page[element.page]
        box = element.bbox
        assert 0 <= box.x0 <= box.x1 <= page.width + 1
        assert 0 <= box.y0 <= box.y1 <= page.height + 1
        assert not box.is_degenerate


# ── Overlap, measured ────────────────────────────────────────────────────────


def ink_coverage(
    fixtures_dir: Path,
    name: str,
    page_no: int,
    boxes: list[tuple[float, float, float, float]],
    *,
    dpi: float = 200.0,
) -> float:
    """What fraction of a page's ink falls inside `boxes`.

    Measured per *pixel* rather than by comparing bounding rectangles, and the
    difference matters on exactly the fixture that matters most. A page
    photographed at three and a half degrees has ink arranged in a staircase;
    the rectangle enclosing all of it includes two large corners with nothing in
    them, so a rectangle-against-rectangle comparison scores a perfect pipeline
    at about a quarter and says nothing.

    The page is rendered independently of the OCR path and binarised locally,
    which is what makes this evidence rather than a restatement: the shadow the
    skewed fixture carries puts its paper darker than the lit half's ink, so a
    single global threshold marks most of the page as ink and the measurement
    becomes meaningless.
    """
    import cv2
    import numpy as np

    from konusbitr_worker.parse.ocr.preprocess import _sauvola
    from konusbitr_worker.parse.ocr.raster import render_page

    raster = render_page(fixtures_dir / name, page_no, dpi=dpi)
    assert raster is not None

    grey = cv2.cvtColor(raster.image, cv2.COLOR_RGB2GRAY)
    # Paper grain is salt-and-pepper and a local threshold will happily call a
    # single dark speck ink. Three pixels of median is enough to drop it and far
    # too little to move a glyph.
    ink = _sauvola(cv2.medianBlur(grey, 3)) == 0
    total = int(ink.sum())
    assert total > 0, "the fixture page has no ink on it"

    covered = np.zeros_like(ink)
    height, width = ink.shape
    points_per_pixel = raster.scale
    for x0, y0, x1, y1 in boxes:
        left = max(0, int(x0 / points_per_pixel))
        top = max(0, int(y0 / points_per_pixel))
        right = min(width, round(x1 / points_per_pixel))
        bottom = min(height, round(y1 / points_per_pixel))
        if right > left and bottom > top:
            covered[top:bottom, left:right] = True

    return float((ink & covered).sum()) / float(total)


@pytest.mark.parametrize(
    "name", ["scanned-letter.pdf", "scanned-rotated.pdf", "scanned-skewed-photo.pdf"]
)
async def test_recognised_boxes_cover_the_ink_on_the_page(
    name: str, settings: Settings, fixtures_dir: Path
) -> None:
    """The coordinate-precision criterion, measured rather than approximated.

    Every box the recogniser produced for a page is painted onto a mask and
    compared against the pixels of that page which actually carry ink, found by
    thresholding an independent render. At least 95% of the ink has to land
    inside a box — which is what "a citation highlight lands on the words"
    means when it is stated as a number.

    This is the assertion that a flipped y axis, a missed page rotation and an
    un-reversed deskew all fail, and it fails them by a wide margin rather than
    marginally: a quarter-turn error scores near zero. Every other coordinate
    test in this file checks one box against an expectation this repository
    wrote down; this one checks every box against the page itself.
    """
    artifact, _store = await parse(name, settings=settings, fixtures_dir=fixtures_dir)

    for page in artifact.pages:
        boxes = [
            (element.bbox.x0, element.bbox.y0, element.bbox.x1, element.bbox.y1)
            for element in artifact.contents
            if element.page == page.page_no
        ]
        assert boxes, f"page {page.page_no} produced no boxes"

        covered = ink_coverage(fixtures_dir, name, page.page_no, boxes)
        assert covered >= 0.95, (
            f"{name} page {page.page_no}: the recognised boxes cover only "
            f"{covered:.1%} of the ink on the page"
        )


# ── Rotation ─────────────────────────────────────────────────────────────────


async def test_rotated_scans_come_back_upright_and_in_the_visible_frame(
    settings: Settings, fixtures_dir: Path
) -> None:
    """One page at each of `/Rotate` 90, 180 and 270.

    Both halves matter. The *text* must be right, which says PDFium applied the
    rotation before the recogniser saw the bitmap. And the *page row* must
    record the frame a reader sees, which is landscape on a quarter turn — a
    pipeline that got the text right and the frame wrong would put every
    highlight a quarter turn from its words while the markdown looked perfect.
    """
    artifact, _store = await parse(
        "scanned-rotated.pdf", settings=settings, fixtures_dir=fixtures_dir
    )

    quarter_turned, upside_down, three_quarters = artifact.pages
    assert (round(quarter_turned.width), round(quarter_turned.height)) == (792, 612)
    assert (round(upside_down.width), round(upside_down.height)) == (612, 792)
    assert (round(three_quarters.width), round(three_quarters.height)) == (792, 612)

    for page_no in (1, 2, 3):
        text = squashed(
            " ".join(element.text for element in artifact.contents if element.page == page_no)
        )
        assert squashed("Konusbitr Scanned Fixture") in text, f"page {page_no} read sideways"


async def test_a_title_on_a_rotated_page_is_still_near_the_top(
    settings: Settings, fixtures_dir: Path
) -> None:
    """A rotation applied twice, or not at all, is invisible in the text and loud here."""
    artifact, _store = await parse(
        "scanned-rotated.pdf", settings=settings, fixtures_dir=fixtures_dir
    )

    for page_no in (1, 2, 3):
        title = next(
            element
            for element in artifact.contents
            if element.page == page_no and "Scanned Fixture" in element.text
        )
        assert title.bbox.y0 < 140, f"page {page_no}: the title is not near the top"
        assert 60 < title.bbox.x0 < 90, f"page {page_no}: the title is not at the margin"


# ── The degraded page ────────────────────────────────────────────────────────


async def test_a_skewed_shadowed_photograph_is_read(settings: Settings, fixtures_dir: Path) -> None:
    """Three and a half degrees of skew, a gradient shadow, and heavy grain.

    This is the fixture that fails if preprocessing is removed: the skew alone
    breaks line grouping, and the shadow alone defeats a global threshold.
    """
    artifact, _store = await parse(
        "scanned-skewed-photo.pdf", settings=settings, fixtures_dir=fixtures_dir
    )

    markdown = squashed(artifact.markdown)
    for phrase in KNOWN_PHRASES:
        assert squashed(phrase) in markdown


async def test_a_deskewed_pages_boxes_stay_on_their_own_ink(
    settings: Settings, fixtures_dir: Path
) -> None:
    """Recognition happens on a straightened page; storage happens on the real one.

    Without the inverse map in `preprocess.Preprocessed.to_source` this test
    still finds the text and puts the title's box most of a line away from the
    title — subtle at the top of the page and obvious at the bottom.
    """
    artifact, _store = await parse(
        "scanned-skewed-photo.pdf", settings=settings, fixtures_dir=fixtures_dir
    )
    page = artifact.pages[0]

    title = next(element for element in artifact.contents if "Scanned Fixture" in element.text)
    assert title.bbox.y0 < 150
    assert 50 < title.bbox.x0 < 100

    for element in artifact.contents:
        assert 0 <= element.bbox.x1 <= page.width + 1
        assert 0 <= element.bbox.y1 <= page.height + 1


# ── Selective tiering ────────────────────────────────────────────────────────


async def test_a_mixed_document_recognises_only_its_scanned_pages(
    settings: Settings, fixtures_dir: Path
) -> None:
    """Seven born-digital pages and three photocopies, in one document.

    The `tier` column is the evidence: native on the pages with a text layer,
    `ocr` on the exhibits, and a confidence recorded only where something
    actually guessed.
    """
    artifact, _store = await parse(
        "mixed-digital-scanned-10p.pdf", settings=settings, fixtures_dir=fixtures_dir
    )

    tiers = {page.page_no: page.tier for page in artifact.pages}
    assert [page for page, tier in tiers.items() if tier is PageTier.native] == [
        1,
        2,
        3,
        4,
        5,
        6,
        7,
    ]
    assert [page for page, tier in tiers.items() if tier is PageTier.ocr] == [8, 9, 10]

    by_page = {page.page_no: page for page in artifact.pages}
    assert by_page[1].ocr_confidence is None, "nothing guessed on a born-digital page"
    assert by_page[8].ocr_confidence is not None


async def test_both_tiers_reach_the_markdown(settings: Settings, fixtures_dir: Path) -> None:
    """A mixed document's markdown must cover all of it.

    Docling's own export covers only what Docling parsed, so a markdown taken
    straight from it would silently omit the scanned exhibits from the summary,
    from corpus-level retrieval, and from any answer drawn from the document as
    a whole.
    """
    artifact, _store = await parse(
        "mixed-digital-scanned-10p.pdf", settings=settings, fixtures_dir=fixtures_dir
    )
    markdown = squashed(artifact.markdown)

    assert squashed("Digital Section 1") in markdown
    assert squashed("Scanned Exhibit") in markdown
    assert squashed("Settlement amount: 12,500 USD") in markdown


async def test_element_ids_stay_a_reading_order_sort_across_both_tiers(
    settings: Settings, fixtures_dir: Path
) -> None:
    """`element_id` is zero-padded so a lexical sort is a reading-order sort.

    Two independently-numbered runs concatenated would break that on every mixed
    document, which is why the merge renumbers from zero.
    """
    artifact, _store = await parse(
        "mixed-digital-scanned-10p.pdf", settings=settings, fixtures_dir=fixtures_dir
    )

    ids = [element.id for element in artifact.contents]
    assert ids == sorted(ids)
    assert len(set(ids)) == len(ids)
    assert [element.page for element in artifact.contents] == sorted(
        element.page for element in artifact.contents
    )


# ── Confidence ───────────────────────────────────────────────────────────────


async def test_every_line_of_a_clean_page_is_read(settings: Settings, fixtures_dir: Path) -> None:
    """A page confidence says nothing about a line the detector never found.

    That is the blind spot this test covers and the reason it is separate from
    the confidence tests below: a recogniser that drops a whole line still
    reports excellent confidence about everything it kept, because confidence is
    computed over what was recognised. `fixtures/generate.py` puts ten known
    lines on this page, and all ten have to come back.
    """
    artifact, _store = await parse(
        "scanned-letter.pdf", settings=settings, fixtures_dir=fixtures_dir
    )
    page_one = squashed(
        " ".join(element.text for element in artifact.contents if element.page == 1)
    )

    for line in (
        "This page exists as pixels and carries no text layer at all",
        "A recogniser has to read it, and the tests know what it says",
        "The quick brown fox jumps over the lazy dog",
        "Invoice total: 4,120 USD. Reference number 88-2401-B",
        "Every bounding box is stored in PDF user-space points with the",
        "origin at the top left of the page as a reader sees it",
    ):
        assert squashed(line) in page_one, f"the page came back without {line!r}"


async def test_a_confidence_is_recorded_for_every_recognised_page(
    settings: Settings, fixtures_dir: Path
) -> None:
    artifact, _store = await parse(
        "scanned-letter.pdf", settings=settings, fixtures_dir=fixtures_dir
    )

    for page in artifact.pages:
        assert page.ocr_confidence is not None
        assert 0.0 <= page.ocr_confidence <= 1.0
        assert page.ocr_engine


async def test_a_clean_scan_is_recognised_with_high_confidence(
    settings: Settings, fixtures_dir: Path
) -> None:
    """Otherwise the number is decoration rather than a signal.

    The badge in the viewer warns below `OCR_LOW_CONFIDENCE_THRESHOLD`, so a
    clean 200 DPI scan of Helvetica scoring below it would make the warning
    meaningless by showing it everywhere.
    """
    artifact, _store = await parse(
        "scanned-letter.pdf", settings=settings, fixtures_dir=fixtures_dir
    )

    for page in artifact.pages:
        assert page.ocr_confidence is not None
        assert page.ocr_confidence > settings.ocr_low_confidence_threshold


async def test_the_artifact_round_trips_the_tier_and_the_confidence(
    settings: Settings, fixtures_dir: Path
) -> None:
    """`parse_results.contents` is what a cached reparse and the viewer both read."""
    artifact, _store = await parse(
        "mixed-digital-scanned-10p.pdf", settings=settings, fixtures_dir=fixtures_dir
    )
    pages = artifact.to_json(include_markdown=False)["pages"]

    assert pages[0]["tier"] == "native"
    assert pages[0]["ocrConfidence"] is None
    assert pages[7]["tier"] == "ocr"
    assert isinstance(pages[7]["ocrConfidence"], float)
