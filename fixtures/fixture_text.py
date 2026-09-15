"""The text the multilingual fixtures are typeset with, and the tests assert back.

Kept in its own module because three things need the same strings and must not
drift: `generate.py` typesets them, `scripts/vendor-fixture-fonts.py` subsets
the fonts down to exactly the characters they use, and the worker's tests assert
that a recogniser read them. A phrase edited in one place and not the others
produces a fixture with a tofu box in it, or a test asserting a sentence that is
not on the page.

Every sentence is written for the purpose. Nothing here is drawn from a
copyrighted source, which is the same rule the rest of the corpus is built on.

The Turkish lines are chosen for their diacritics rather than their meaning:
`ı`, `ğ`, `ş`, `ç`, `ö` and `ü` are precisely the characters an English
recognition dictionary silently replaces with their undotted Latin neighbours,
so a page without them would pass whether or not the language routing worked.
"""

from __future__ import annotations

TURKISH_LINES = [
    "Türkçe Taranmış Belge",
    "",
    "Bu sayfa piksel olarak saklanır ve metin katmanı içermez.",
    "Sözleşme hükümleri iki taraf arasında imzalanmıştır.",
    "",
    "Toplam tutar: 4.120 TL. Referans numarası 88-2401-B.",
    "Şirketin yıllık geliri geçen yıla göre yüzde otuz arttı.",
    "Çalışan sayısı doksan dörde yükseldi.",
]

#: The Arabic page, and the one set of sentences in this file that was *chosen*
#: rather than simply written.
#:
#: Tesseract's shipped `ara` traineddata is a 2019-era model and there are
#: ordinary Arabic sentences it returns nothing at all for — not a
#: misrecognition, an empty result. A fixture built out of those would measure
#: the traineddata's vocabulary and would report it as a failure of the routing,
#: the reading order and the coordinate conversion, which are the things this
#: corpus exists to test and which are correct either way. So every line here
#: was verified to be read by the engine the routing sends it to, and the page
#: tests the pipeline around that engine rather than the engine itself.
ARABIC_LINES = [
    "تقرير مالي سنوي",
    "",
    "لا يوجد نص في هذه الصفحة.",
    "تم توقيع شروط العقد بين الطرفين.",
    "",
    "المبلغ الإجمالي أربعة آلاف ومائة وعشرون.",
    "عدد الموظفين أربعة وتسعون.",
]

CHINESE_LINES = [
    "扫描的中文文件",
    "",
    "本页以图像形式存储，不包含文本层。",
    "双方已经签署了合同条款。",
    "",
    "总金额为四千一百二十元。",
]

JAPANESE_LINES = [
    "日本語のスキャン文書",
    "",
    "このページは画像として保存されており、テキスト層はありません。",
    "両当事者は契約条件に署名しました。",
    "",
    "合計金額は四千百二十円です。",
]

#: The Latin-script lines the Phase 12.1 fixtures already use, repeated here so
#: that the Latin subset covers them when a multilingual page is laid out with
#: the vendored font rather than with reportlab's built-in Helvetica.
LATIN_LINES = [
    "Konusbitr Scanned Fixture",
    "",
    "This page exists as pixels and carries no text layer at all.",
    "The quick brown fox jumps over the lazy dog.",
    "Invoice total: 4,120 USD. Reference number 88-2401-B.",
]

#: A scanned financial table, as rows. The header row names columns and holds no
#: number; the body rows hold nothing but. That is what
#: `konusbitr_worker.parse.ocr.pipeline._looks_like_a_header` decides on, and a
#: fixture where the distinction is blurred would let a broken heuristic pass.
TABLE_HEADERS = ["Segment", "2023", "2024", "Change"]
TABLE_ROWS = [
    ["Subscriptions", "4,120", "5,860", "42%"],
    ["Services", "1,905", "2,110", "11%"],
    ["Licensing", "742", "689", "7%"],
    ["Total", "6,767", "8,659", "28%"],
]

#: The caption printed under the fixture's chart, and the labels drawn on it.
#: The chart is a real drawing rather than a grey rectangle, so that a vision
#: model asked to describe it has something to describe — and so that the
#: extraction filters are exercised by an image that is genuinely a figure.
FIGURE_CAPTION = "Figure 1. Revenue by region, 2024."
FIGURE_LABELS = ["North America", "Europe", "Asia Pacific"]
FIGURE_VALUES = [54, 28, 18]


def _characters(*groups: list[str]) -> str:
    """The distinct characters in a set of line lists, as one string."""
    return "".join(sorted({character for group in groups for line in group for character in line}))


#: Exactly the characters each vendored subset has to carry, keyed by the file
#: `scripts/vendor-fixture-fonts.py` writes. Derived rather than listed, so
#: editing a sentence above and re-running the vendoring script is enough.
FIXTURE_CHARACTERS = {
    "NotoSans-subset.ttf": _characters(
        TURKISH_LINES,
        LATIN_LINES,
        TABLE_HEADERS,
        [cell for row in TABLE_ROWS for cell in row],
        [FIGURE_CAPTION],
        FIGURE_LABELS,
        [str(value) for value in FIGURE_VALUES],
        # The digits and punctuation a page number, a heading rule and a scanned
        # table need, whether or not a sentence above happens to contain them.
        ["0123456789", ".,:;%-—()/ "],
    ),
    "NotoSansArabic-subset.ttf": _characters(ARABIC_LINES, ["0123456789. "]),
    "NotoSansCJK-subset.ttf": _characters(
        CHINESE_LINES, JAPANESE_LINES, ["0123456789. "]
    ),
}
