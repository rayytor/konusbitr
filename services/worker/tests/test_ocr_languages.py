"""Which engine and which dictionary a document is read with.

The routing is the whole of Phase 12.2's first idea, and almost none of it can
be tested by running a recogniser: the point of the module is the decision taken
*before* one runs. So these tests are about the decision — tag normalisation,
the precedence between an explicit `langList` and an identified language, which
engine a script is sent to, and what happens when the weights a language wants
are not installed.

The identification tests do run `fast-langdetect`, against sentences written
here. It uses the FastText model bundled in its own wheel, so this needs no
network and works under `OFFLINE_MODE` — which is the reason it was chosen over
the alternatives and is worth asserting rather than assuming.
"""

from __future__ import annotations

import pytest

from konusbitr_worker.parse.ocr.languages import (
    LanguagePlan,
    detect_languages,
    normalize_tags,
    plan_languages,
    script_of,
)

# ── Normalisation ────────────────────────────────────────────────────────────


class TestNormalizeTags:
    @pytest.mark.parametrize(
        ("given", "expected"),
        [
            (["tr"], ("tr",)),
            (["tr-TR"], ("tr",)),
            (["TR"], ("tr",)),
            (["tr_TR"], ("tr",)),
            # ISO 639-3, which is what somebody who has used Tesseract types.
            (["tur"], ("tr",)),
            (["eng"], ("en",)),
            (["ara"], ("ar",)),
            # Deprecated codes that are still sent by real clients.
            (["iw"], ("he",)),
            (["in"], ("id",)),
        ],
    )
    def test_a_tag_reduces_to_its_primary_subtag(
        self, given: list[str], expected: tuple[str, ...]
    ) -> None:
        assert normalize_tags(given) == expected

    def test_traditional_chinese_keeps_its_script(self) -> None:
        """The one script subtag that changes which dictionary is loaded.

        `zh-Hans` and `zh` are one recognition head; `zh-Hant` is a different
        Tesseract traineddata, so dropping the subtag would read a Taiwanese
        filing with the simplified character set.
        """
        assert normalize_tags(["zh-Hans-CN"]) == ("zh",)
        assert normalize_tags(["zh-Hant"]) == ("zh-hant",)
        assert normalize_tags(["zh-TW"]) == ("zh-hant",)

    def test_order_is_preserved_and_duplicates_are_dropped(self) -> None:
        """The first tag is the primary language; the precedence depends on it."""
        assert normalize_tags(["zh", "en", "ZH", "zh-CN"]) == ("zh", "en")

    def test_junk_narrows_the_parse_rather_than_failing_it(self) -> None:
        """`langList` arrives over a public API, and a bad tag is not an outage."""
        assert normalize_tags(["", "  ", "!!", "englishhh", "tr"]) == ("tr",)


# ── Script identification ────────────────────────────────────────────────────


class TestScriptOf:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("Revenue grew across every segment", "latin"),
            ("هذا المستند مكتوب باللغة العربية", "arabic"),
            ("המסמך הזה כתוב בעברית", "hebrew"),
            ("Настоящий документ составлен", "cyrillic"),
            ("本文件以中文书写", "han"),
            ("このページは画像です", "japanese"),
            ("이 문서는 한국어로", "korean"),
            ("यह दस्तावेज़ हिंदी में है", "devanagari"),
            # Digits and punctuation alone have no script.
            ("4,120  88-2401-B", "latin"),
        ],
    )
    def test_the_dominant_script_is_identified(self, text: str, expected: str) -> None:
        assert script_of(text) == expected


class TestDetectLanguages:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("Bu belge Türkçe yazılmıştır ve sözleşme hükümlerini içerir.", "tr"),
            ("هذا المستند مكتوب باللغة العربية ويحتوي على شروط العقد.", "ar"),
            ("本文書は日本語で書かれており、契約条件が含まれています。", "ja"),
            ("本文件以中文书写，包含双方之间的合同条款。", "zh"),
            ("Revenue grew across every reported segment during the year.", "en"),
            ("Настоящий документ составлен на русском языке.", "ru"),
        ],
    )
    def test_the_primary_language_of_a_sentence_is_identified(
        self, text: str, expected: str
    ) -> None:
        detected = detect_languages(text)
        assert detected, "fast-langdetect returned nothing for a clear sentence"
        assert detected[0] == expected

    def test_a_sample_too_short_to_classify_returns_nothing(self) -> None:
        """FastText always returns *a* label. Nothing is the honest answer here.

        Taking the label anyway routes a page of figures to whichever dictionary
        a 0.04 score happened to name.
        """
        assert detect_languages("") == ()
        assert detect_languages("4,120") == ()


# ── The dispatch ─────────────────────────────────────────────────────────────


class TestPrecedence:
    def test_an_explicit_langlist_wins_over_identification(self) -> None:
        """The operator knows something the identifier cannot infer from a scan.

        The sample here is unambiguously English; the request says Turkish; the
        request wins, because a scanned Turkish contract with an English cover
        page is exactly why `langList` exists.
        """
        plan = plan_languages(
            requested=["tr"],
            sample="Revenue grew across every reported segment during the year.",
        )
        assert plan.tags == ("tr",)
        assert plan.source == "requested"
        assert "tur" in plan.tesseract_languages

    def test_an_absent_langlist_falls_through_to_identification(self) -> None:
        plan = plan_languages(sample="本文件以中文书写，包含双方之间的合同条款。")
        assert plan.primary == "zh"
        assert plan.source == "detected"

    def test_a_document_with_no_text_at_all_takes_the_default(self) -> None:
        plan = plan_languages()
        assert plan.tags == ("en",)
        assert plan.source == "default"
        assert plan.tesseract_languages == "eng"

    def test_the_script_overrules_a_label_it_contradicts(self) -> None:
        """FastText scores a short, number-heavy sample poorly and still answers.

        The script is not a matter of opinion, so where the two disagree the
        script takes the primary slot. A confident `en` over a page of Arabic is
        a misclassification and routing on it would produce Latin noise.
        """
        plan = plan_languages(sample="العقد 4120 88-2401-B الطرفين")
        assert plan.primary == "ar"
        assert plan.rtl is True

    def test_a_latin_label_is_not_demoted_to_english(self) -> None:
        """The one direction not to correct.

        Turkish, Vietnamese, Polish and German are all Latin-script, so
        "the script says latin, the label says tr" is not a disagreement — and
        promoting `en` over `tr` would undo the routing this module exists for.
        """
        plan = plan_languages(sample="Bu belge Türkçe yazılmıştır ve sözleşme hükümlerini içerir.")
        assert plan.primary == "tr"


class TestEngineDispatch:
    def test_arabic_and_hebrew_go_to_tesseract_and_read_right_to_left(self) -> None:
        """Contextual shaping is outside what a PP-OCR CRNN head reconstructs."""
        for tag, pack in (("ar", "ara"), ("he", "heb")):
            plan = plan_languages(requested=[tag])
            assert plan.prefer_tesseract is True
            assert plan.rtl is True
            assert plan.tesseract_languages.startswith(pack)

    def test_latin_and_chinese_stay_on_the_shipped_model(self) -> None:
        """PP-OCRv4's shipped head covers both, so neither needs a fallback first."""
        for tag in ("en", "zh", "fr"):
            plan = plan_languages(requested=[tag])
            assert plan.prefer_tesseract is False
            assert plan.rapid_model_path is None
            assert plan.rtl is False

    def test_a_language_whose_weights_are_absent_is_routed_to_tesseract(self) -> None:
        """ "Wants a dictionary" and "has one" are different states.

        The Japanese recognition head is a separate download and this module
        never fetches one. Reading a Japanese page with the Chinese dictionary
        would return confident kanji and no kana at all, so the engine that does
        have a Japanese model is used instead.
        """
        plan = plan_languages(requested=["ja"], model_dir=None)
        assert plan.prefer_tesseract is True
        assert plan.unsupported == ("ja",)
        assert plan.tesseract_languages.startswith("jpn")

    def test_installed_weights_are_used_and_keep_the_primary_engine(self, tmp_path) -> None:
        (tmp_path / "japan_PP-OCRv4_rec_infer.onnx").write_bytes(b"weights")
        (tmp_path / "japan_dict.txt").write_text("a\n", encoding="utf-8")

        plan = plan_languages(requested=["ja"], model_dir=str(tmp_path))
        assert plan.prefer_tesseract is False
        assert plan.unsupported == ()
        assert plan.rapid_model_path is not None
        assert plan.rapid_keys_path is not None

    def test_a_half_installed_model_is_not_used(self) -> None:
        """A recognition head and its character dictionary are one artifact.

        Loading Japanese weights against the shipped Chinese dictionary decodes
        every CTC index to the wrong glyph, silently and with high confidence.
        """
        plan = plan_languages(requested=["ja"], model_dir="/nonexistent")
        assert plan.rapid_model_path is None

    def test_english_is_appended_rather_than_replaced(self) -> None:
        """Real documents in every language carry English names and units.

        Tesseract weighs the packs it is given rather than picking one, so the
        cost is a little speed and the benefit is that a product name inside a
        Turkish contract survives.
        """
        plan = plan_languages(requested=["tr", "zh"])
        assert plan.tesseract_languages == "tur+chi_sim+eng"

    def test_an_unrecognised_tag_reads_as_latin_rather_than_failing(self) -> None:
        plan = plan_languages(requested=["qq"])
        assert plan.tesseract_languages == "eng"
        assert plan.prefer_tesseract is False


def test_a_plan_describes_itself_without_quoting_the_document() -> None:
    """`describe()` goes into a log line, and document text never reaches telemetry."""
    described = plan_languages(requested=["ar"]).describe()
    assert set(described) == {
        "languages",
        "source",
        "tesseract_languages",
        "rapid_model",
        "prefer_tesseract",
        "rtl",
        "unsupported",
    }
    assert described["languages"] == ["ar"]


def test_the_default_plan_is_the_phase_12_1_behaviour() -> None:
    """A caller that resolves nothing gets exactly what Phase 12.1 did."""
    plan = LanguagePlan()
    assert plan.tags == ("en",)
    assert plan.tesseract_languages == "eng"
    assert plan.prefer_tesseract is False
    assert plan.rtl is False
