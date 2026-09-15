"""The real recogniser over the real non-Latin corpus.

`test_ocr_languages.py` tests the decision; this tests the reading. The fixture
is `multilingual-scan-4p.pdf` — four scanned pages, one script each, typeset by
`fixtures/generate.py` — so this file knows exactly what each page says and can
assert a *recognition rate* rather than record whatever came back.

**Some of these need a Tesseract language pack** and skip cleanly without one.
That is not a hole in the coverage so much as an honest statement of what the
default image provides: `docker/worker.Dockerfile` installs the packs, CI
installs them, and a developer who has not run `apt install tesseract-ocr-ara`
gets a skip that says so rather than a failure they cannot act on. The Chinese
page needs nothing, because PP-OCRv4's shipped recognition head reads Chinese —
which is the reason it is the primary engine.

Slow, and marked `slow`: a 300 DPI rasterisation and a recognition pass per
page. CI runs it; `-m "not slow"` is the loop to iterate in.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from konusbitr_worker.parse import parse_document
from konusbitr_worker.parse.artifact import ParseArtifact
from konusbitr_worker.settings import Settings
from tests.factories import FakeObjectStore, sha256_of

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "fixtures"))

from fixture_text import (
    ARABIC_LINES,
    CHINESE_LINES,
    JAPANESE_LINES,
    TURKISH_LINES,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.slow]

FIXTURE = "multilingual-scan-4p.pdf"

#: Which page of the fixture carries which script, and what it says.
PAGES = {
    "tr": (1, TURKISH_LINES),
    "ar": (2, ARABIC_LINES),
    "zh": (3, CHINESE_LINES),
    "ja": (4, JAPANESE_LINES),
}

#: The phase's own number. A page read at this rate has every sentence legible
#: and a handful of characters wrong, which is what a scan of a real document
#: produces and what a citation can still be verified against.
MIN_RECOGNITION_RATE = 0.90


def tesseract_has(language: str) -> bool:
    """Whether a traineddata set is installed. Cached by pytest's own collection."""
    if shutil.which("tesseract") is None:
        return False
    try:
        listed = subprocess.run(
            ["tesseract", "--list-langs"], capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.SubprocessError):  # pragma: no cover - environment
        return False
    return language in listed.stdout.split()


def requires(language: str, pack: str):
    return pytest.mark.skipif(
        not tesseract_has(pack),
        reason=(
            f"the {language} page needs the {pack} Tesseract traineddata "
            f"(apt install tesseract-ocr-{pack.replace('_', '-')})"
        ),
    )


async def parse(
    fixtures_dir: Path, settings: Settings, *, lang_list: list[str] | None = None
) -> ParseArtifact:
    source = fixtures_dir / FIXTURE
    return await parse_document(
        store=FakeObjectStore(source=source),
        settings=settings,
        org_id="org_test",
        document_id="doc_fixture",
        storage_key="orgs/org_test/documents/doc_fixture/original.pdf",
        content_hash=sha256_of(source),
        lang_list=lang_list or [],
    )


def page_text(artifact: ParseArtifact, page_no: int) -> str:
    return " ".join(element.text for element in artifact.contents if element.page == page_no)


def recognition_rate(expected: list[str], produced: str) -> float:
    """The fraction of the page's characters that came back.

    A bag-of-characters measure rather than an edit distance, and deliberately.
    An edit distance over a page is dominated by where the recogniser chose to
    break lines — which is a layout decision this tier makes itself and which no
    two engines agree on — and would fail a perfectly read page for rewrapping
    it. What has to be true is that the *characters on the page* came back,
    which is exactly what a wrong dictionary destroys: a dotless i read as an
    l and every diacritic dropped is a large, measurable loss on this measure
    and invisible on a loose one.
    """
    wanted: dict[str, int] = {}
    for line in expected:
        for character in line:
            if not character.isspace():
                wanted[character] = wanted.get(character, 0) + 1

    got: dict[str, int] = {}
    for character in produced:
        if not character.isspace():
            got[character] = got.get(character, 0) + 1

    total = sum(wanted.values())
    if total == 0:  # pragma: no cover - the fixture is not empty
        return 0.0
    matched = sum(min(count, got.get(character, 0)) for character, count in wanted.items())
    return matched / total


# ── Recognition, with the languages named ────────────────────────────────────


@requires("Turkish", "tur")
async def test_turkish_is_read_with_its_own_diacritics(
    settings: Settings, fixtures_dir: Path
) -> None:
    """The acceptance criterion, and the case that is silent when it fails.

    Turkish is Latin-script, so an English dictionary produces *plausible*
    output for it: a dotless i read as an l, every diacritic dropped. The
    markdown looks fine and the recognition rate does not, which is why the
    assertion is a rate rather than a phrase.
    """
    artifact = await parse(fixtures_dir, settings, lang_list=["tr"])
    produced = page_text(artifact, 1)

    assert recognition_rate(TURKISH_LINES, produced) >= MIN_RECOGNITION_RATE
    assert "Türkçe" in produced
    assert "Şirketin" in produced or "şirketin" in produced.lower()


@requires("Arabic", "ara")
async def test_arabic_is_read_in_logical_order(settings: Settings, fixtures_dir: Path) -> None:
    """RTL coherence: the characters of a sentence in the order a reader reads them.

    Getting this wrong does not produce garbage, which is what makes it
    dangerous — it produces a sentence with its words reversed, which reads as a
    recognition failure, embeds as nonsense, and can never be matched by the
    quote verifier against anything a model quotes back.
    """
    artifact = await parse(fixtures_dir, settings, lang_list=["ar"])
    produced = page_text(artifact, 2)

    assert recognition_rate(ARABIC_LINES, produced) >= MIN_RECOGNITION_RATE
    # The sentence, whole and in order — not merely its characters.
    assert "تم توقيع شروط العقد بين الطرفين" in produced


@requires("Arabic", "ara")
async def test_a_latin_page_inside_an_arabic_document_is_not_reversed(
    settings: Settings, fixtures_dir: Path
) -> None:
    """Direction is a property of the line, not of the document.

    This is the regression a document-level `rtl` flag caused: with
    `langList=['ar']` the Turkish page came back as `Belge Taranmis Turkce`,
    every word correct and every sentence backwards.
    """
    artifact = await parse(fixtures_dir, settings, lang_list=["ar"])
    produced = page_text(artifact, 1)

    # The title reads "Türkçe Taranmış Belge". Reversed, it reads
    # "Belge Taranmis Turkce" — every word correct and the sentence backwards.
    assert "Taranm" in produced and "Belge" in produced
    assert produced.index("Taranm") < produced.index("Belge")


async def test_chinese_is_read_by_the_shipped_model_with_no_extra_packs(
    settings: Settings, fixtures_dir: Path
) -> None:
    """PP-OCRv4's shipped recognition head covers Chinese and Latin.

    That is the reason it is the primary engine and the reason the default image
    reads a Chinese scan out of the box, with no `apt install` and no download.
    """
    artifact = await parse(fixtures_dir, settings, lang_list=["zh"])
    produced = page_text(artifact, 3)

    assert recognition_rate(CHINESE_LINES, produced) >= MIN_RECOGNITION_RATE
    assert "扫描的中文文件" in produced


@requires("Japanese", "jpn")
async def test_japanese_is_routed_to_the_engine_that_has_a_model_for_it(
    settings: Settings, fixtures_dir: Path
) -> None:
    """Kanji alone is not Japanese.

    The Chinese head reads the kanji of a Japanese page confidently and drops
    the kana, which is a high-confidence partial reading — the worst kind. The
    Japanese PP-OCR head is a separate download this project never fetches, so
    the page is routed to Tesseract, which has a pack.
    """
    artifact = await parse(fixtures_dir, settings, lang_list=["ja"])
    produced = page_text(artifact, 4)

    assert artifact.pages[3].ocr_engine == "tesseract"
    # Tesseract spaces Japanese glyphs apart; the characters are what is asserted.
    assert recognition_rate(JAPANESE_LINES, produced) >= MIN_RECOGNITION_RATE


# ── Recognition, with nothing named ──────────────────────────────────────────


async def test_the_language_is_identified_when_no_langlist_is_given(
    settings: Settings, fixtures_dir: Path
) -> None:
    """The auto-detection criterion, end to end and with no user input.

    A wholly scanned document has no text to identify until something has been
    recognised, so the first page is read with the default dispatch, identified,
    and re-read only if the answer needs a different engine. What this asserts is
    that the document comes back *readable* rather than that a particular engine
    ran — the identification has done its job when the page says what the page
    says.
    """
    artifact = await parse(fixtures_dir, settings)

    # Chinese needs no pack and is the page that must be right on any machine.
    assert recognition_rate(CHINESE_LINES, page_text(artifact, 3)) >= MIN_RECOGNITION_RATE
    assert all(page.tier.value == "ocr" for page in artifact.pages)
