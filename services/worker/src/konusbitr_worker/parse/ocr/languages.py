"""Which recogniser reads a page, and in which language.

Phase 12.1 ran one engine with one dictionary over every scan, which is correct
for the English-language corpus it was measured on and produces unindexable
noise on everything else: PP-OCRv4's shipped recognition head knows Chinese and
Latin characters, so an Arabic page comes back as a scattering of plausible
Latin tokens with a *high* confidence — the worst possible failure, because
nothing downstream can tell it from a reading.

So a document is routed before it is read, by the precedence the phase
specifies:

    settings.langList given?  ──yes──►  normalise the tags, dispatch on them
                              ──no───►  sample the document's text, identify it
                                        with fast-langdetect, dispatch on that

Two things about the dispatch are worth stating plainly, because both are
constraints rather than preferences.

**RapidOCR ships one recognition dictionary.** The wheel contains the Chinese
and English PP-OCRv4 weights and nothing else; the Japanese, Korean, Latin,
Cyrillic and Devanagari heads are separate downloads. Fetching one at run time
would break `OFFLINE_MODE` and put a network call in the middle of a parse, so
this module never downloads anything. It looks for the extra weights in
`OCR_MODEL_DIR`, uses them when an operator has placed them there, and falls
back to Tesseract — whose language packs are `apt install tesseract-ocr-jpn` —
when they are absent. A deployment that installs neither still recognises
Latin-script pages with the shipped model, which is the Phase 12.1 behaviour.

**Some scripts go to Tesseract even when RapidOCR could try.** Arabic and
Hebrew are written right-to-left with contextual letter shaping, and Devanagari
composes conjuncts; the PP-OCR detector-plus-CRNN arrangement handles none of
that, while Tesseract's LSTM was trained per-script and does. Turkish and
Vietnamese are Latin-script and would *almost* work on the shipped model — and
"almost" means a dotless i read as an l and every diacritic dropped, which is
a silent corruption rather than a visible failure. Both have a Tesseract pack.

Nothing here decides *reading order*; that is
:mod:`konusbitr_worker.parse.ocr.layout`, which is told `rtl` by the plan this
module returns.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from konusbitr_worker.log import get_logger

__all__ = [
    "DEFAULT_LANGUAGE",
    "RTL_LANGUAGES",
    "LanguagePlan",
    "detect_languages",
    "normalize_tags",
    "plan_languages",
    "script_of",
]

logger = get_logger("konusbitr.worker.parse.ocr.languages")

#: What an unrouted document is read as. English, because the shipped PP-OCRv4
#: recognition head covers Latin script and because it is what Phase 12.1 did.
DEFAULT_LANGUAGE = "en"

#: Languages whose logical reading order runs right to left. The property is a
#: language's rather than a script's for our purposes: it is what
#: :mod:`konusbitr_worker.parse.ocr.layout` sorts a line's words by.
RTL_LANGUAGES = frozenset({"ar", "arz", "fa", "he", "iw", "ps", "ur", "yi", "ji", "dv", "syr"})

#: BCP-47 tags that mean the same language under two spellings, plus the
#: deprecated ISO codes that still turn up in real API requests.
_TAG_ALIASES: dict[str, str] = {
    "iw": "he",
    "ji": "yi",
    "in": "id",
    "mo": "ro",
    "zh-cn": "zh",
    "zh-hans": "zh",
    "zh-sg": "zh",
    "zh-tw": "zh-hant",
    "zh-hk": "zh-hant",
    "zh-hant": "zh-hant",
    "cmn": "zh",
    "nb": "no",
    "nn": "no",
}

#: ISO 639-3 spellings of the languages this module routes, mapped to the two
#: letter form BCP-47 prefers. Callers send both: `tur` because that is what a
#: Tesseract user types, `tr` because that is what a browser sends.
_ISO3_TO_ISO1: dict[str, str] = {
    "ara": "ar",
    "aze": "az",
    "bel": "be",
    "ben": "bn",
    "bul": "bg",
    "ces": "cs",
    "cze": "cs",
    "deu": "de",
    "ger": "de",
    "ell": "el",
    "gre": "el",
    "eng": "en",
    "fas": "fa",
    "per": "fa",
    "fin": "fi",
    "fra": "fr",
    "fre": "fr",
    "heb": "he",
    "hin": "hi",
    "hun": "hu",
    "ind": "id",
    "ita": "it",
    "jpn": "ja",
    "kat": "ka",
    "kaz": "kk",
    "kor": "ko",
    "mkd": "mk",
    "nld": "nl",
    "dut": "nl",
    "nor": "no",
    "pol": "pl",
    "por": "pt",
    "ron": "ro",
    "rum": "ro",
    "rus": "ru",
    "spa": "es",
    "srp": "sr",
    "swe": "sv",
    "tha": "th",
    "tur": "tr",
    "ukr": "uk",
    "urd": "ur",
    "vie": "vi",
    "chi": "zh",
    "zho": "zh",
}

#: Tesseract traineddata names, by language. The value is what goes after
#: `-l`; a document with several languages joins them with `+`.
#:
#: Only languages with a genuinely different script or a genuinely different
#: alphabet are listed. Everything Latin and unlisted resolves to `eng`, which
#: is not a claim that the document is English — it is a claim that the shipped
#: Latin character set covers it, which for French, German, Spanish, Italian,
#: Dutch and the Nordic languages it does.
_TESSERACT_PACKS: dict[str, str] = {
    "ar": "ara",
    "az": "aze",
    "be": "bel",
    "bg": "bul",
    "bn": "ben",
    "cs": "ces",
    "de": "deu",
    "el": "ell",
    "es": "spa",
    "fa": "fas",
    "fi": "fin",
    "fr": "fra",
    "he": "heb",
    "hi": "hin",
    "hu": "hun",
    "id": "ind",
    "it": "ita",
    "ja": "jpn",
    "ka": "kat",
    "kk": "kaz",
    "ko": "kor",
    "mk": "mkd",
    "nl": "nld",
    "no": "nor",
    "pl": "pol",
    "pt": "por",
    "ro": "ron",
    "ru": "rus",
    "sr": "srp",
    "sv": "swe",
    "th": "tha",
    "tr": "tur",
    "uk": "ukr",
    "ur": "urd",
    "vi": "vie",
    "zh": "chi_sim",
    "zh-hant": "chi_tra",
}

#: Which RapidOCR recognition dictionary a language wants, and the file names
#: PaddleOCR publishes it under. `None` means the shipped weights already cover
#: it: PP-OCRv4's Chinese head includes the full Latin alphabet and digits,
#: which is why English and Chinese are one model rather than two.
#:
#: The tuple is `(model file, character dictionary)`, looked for under
#: `OCR_MODEL_DIR`. Nothing is ever downloaded — see the module docstring.
_RAPID_DICTIONARIES: dict[str, tuple[str, str]] = {
    "ja": ("japan_PP-OCRv4_rec_infer.onnx", "japan_dict.txt"),
    "ko": ("korean_PP-OCRv4_rec_infer.onnx", "korean_dict.txt"),
    "ru": ("cyrillic_PP-OCRv4_rec_infer.onnx", "cyrillic_dict.txt"),
    "uk": ("cyrillic_PP-OCRv4_rec_infer.onnx", "cyrillic_dict.txt"),
    "bg": ("cyrillic_PP-OCRv4_rec_infer.onnx", "cyrillic_dict.txt"),
    "sr": ("cyrillic_PP-OCRv4_rec_infer.onnx", "cyrillic_dict.txt"),
    "mk": ("cyrillic_PP-OCRv4_rec_infer.onnx", "cyrillic_dict.txt"),
    "be": ("cyrillic_PP-OCRv4_rec_infer.onnx", "cyrillic_dict.txt"),
    "kk": ("cyrillic_PP-OCRv4_rec_infer.onnx", "cyrillic_dict.txt"),
    "el": ("latin_PP-OCRv4_rec_infer.onnx", "latin_dict.txt"),
    "tr": ("latin_PP-OCRv4_rec_infer.onnx", "latin_dict.txt"),
    "vi": ("latin_PP-OCRv4_rec_infer.onnx", "latin_dict.txt"),
    "pl": ("latin_PP-OCRv4_rec_infer.onnx", "latin_dict.txt"),
    "cs": ("latin_PP-OCRv4_rec_infer.onnx", "latin_dict.txt"),
    "hu": ("latin_PP-OCRv4_rec_infer.onnx", "latin_dict.txt"),
    "ro": ("latin_PP-OCRv4_rec_infer.onnx", "latin_dict.txt"),
    "hi": ("devanagari_PP-OCRv4_rec_infer.onnx", "devanagari_dict.txt"),
}

#: Languages the primary engine must not be asked to read, whatever weights are
#: present. See the module docstring: contextual shaping and conjunct-forming
#: scripts are outside what a PP-OCR CRNN head reconstructs, and a wrong reading
#: at high confidence is worse than a fallback that is merely slower.
_TESSERACT_ONLY = frozenset({"ar", "arz", "fa", "he", "ps", "ur", "yi", "dv", "syr", "th"})

#: Unicode script ranges, for the fallback identifier and for the sanity check
#: on a detected tag. Coarse on purpose: this answers "which recognition
#: dictionary", and that question has about eight answers.
_SCRIPT_RANGES: tuple[tuple[int, int, str], ...] = (
    (0x0590, 0x05FF, "hebrew"),
    (0x0600, 0x06FF, "arabic"),
    (0x0700, 0x074F, "syriac"),
    (0x0750, 0x077F, "arabic"),
    (0x0900, 0x097F, "devanagari"),
    (0x0980, 0x09FF, "bengali"),
    (0x0E00, 0x0E7F, "thai"),
    (0x0400, 0x04FF, "cyrillic"),
    (0x0370, 0x03FF, "greek"),
    (0x3040, 0x309F, "japanese"),
    (0x30A0, 0x30FF, "japanese"),
    (0xAC00, 0xD7AF, "korean"),
    (0x1100, 0x11FF, "korean"),
    (0x4E00, 0x9FFF, "han"),
    (0x3400, 0x4DBF, "han"),
    (0xFB50, 0xFDFF, "arabic"),
    (0xFE70, 0xFEFF, "arabic"),
)

#: One representative language per script, for the fallback identifier. Han is
#: `zh` rather than `ja` because a page of Han characters with no kana is
#: Chinese; a Japanese page almost always carries kana, which is detected first.
_SCRIPT_LANGUAGE: dict[str, str] = {
    "arabic": "ar",
    "hebrew": "he",
    "syriac": "syr",
    "devanagari": "hi",
    "bengali": "bn",
    "thai": "th",
    "cyrillic": "ru",
    "greek": "el",
    "japanese": "ja",
    "korean": "ko",
    "han": "zh",
    "latin": "en",
}

#: How much of a document's text is shown to the identifier.
#:
#: FastText classifies a sentence reliably and a page overwhelmingly so; the
#: cost is linear in the input and the accuracy is flat well before this. The
#: cap exists because a 500-page document's markdown is megabytes and none of
#: it after the first few thousand characters changes the answer.
DETECTION_SAMPLE_CHARS = 4000

#: Scores below this are noise. FastText always returns *a* label — on an empty
#: string, on a page of numbers — and taking that label would route a table of
#: figures to a Cyrillic dictionary on a 0.04 score.
DETECTION_MIN_SCORE = 0.25

#: How many candidates are kept. The phase asks for the primary language plus
#: any genuine second one, which is what a mixed Chinese/English filing has.
DETECTION_CANDIDATES = 3


@dataclass(frozen=True, slots=True)
class LanguagePlan:
    """Which engine reads this document, with which dictionary, in which order.

    One plan per document rather than per page. Per-page identification is
    tempting and wrong at this tier: a language identifier needs text, the only
    text a scanned page has is the text we are about to recognise, and a
    first-pass recognition per page to decide the second pass would double the
    cost of every scan to serve the rare document that changes script midway.
    The `langList` escape hatch covers that document explicitly.
    """

    #: Normalised BCP-47 tags, primary first.
    tags: tuple[str, ...] = (DEFAULT_LANGUAGE,)
    #: Whether the tags were asked for or inferred. Diagnostic, and it is what
    #: the log line needs to be worth reading.
    source: str = "default"
    #: `-l` value for Tesseract, e.g. `tur+eng`.
    tesseract_languages: str = "eng"
    #: Alternative RapidOCR recognition weights, when one is both wanted and
    #: present on disk. `None` means the shipped Chinese/Latin head.
    rapid_model_path: str | None = None
    rapid_keys_path: str | None = None
    #: True when the primary engine is Tesseract rather than RapidOCR.
    prefer_tesseract: bool = False
    #: True when the document's primary language is written right to left.
    rtl: bool = False
    #: Tags that wanted an engine or a dictionary this deployment does not have.
    #: Logged once per document; a caller may surface it.
    unsupported: tuple[str, ...] = field(default_factory=tuple)

    @property
    def primary(self) -> str:
        return self.tags[0] if self.tags else DEFAULT_LANGUAGE

    def describe(self) -> dict[str, object]:
        """The log line's `extra`. Contains no document text, by construction."""
        return {
            "languages": list(self.tags),
            "source": self.source,
            "tesseract_languages": self.tesseract_languages,
            "rapid_model": Path(self.rapid_model_path).name if self.rapid_model_path else None,
            "prefer_tesseract": self.prefer_tesseract,
            "rtl": self.rtl,
            "unsupported": list(self.unsupported),
        }


def normalize_tags(tags: Iterable[str]) -> tuple[str, ...]:
    """Reduce BCP-47-ish tags to the primary subtags this module dispatches on.

    `tr-TR` and `TR` are Turkish; `zh-Hans-CN` is Chinese and `zh-Hant` is not
    quite the same Chinese, so the script subtag survives for that one case and
    is dropped everywhere else — it is the only script distinction that changes
    which dictionary is loaded.

    Order is preserved and duplicates are dropped, because the first tag is the
    primary language and the phase's precedence hierarchy depends on that.
    Anything that is not a plausible language subtag is discarded rather than
    raising: `langList` comes in over a public API and a junk tag should narrow
    the parse to the default, not fail an upload.
    """
    seen: list[str] = []
    for raw in tags:
        tag = str(raw or "").strip().lower().replace("_", "-")
        if not tag:
            continue

        # Whole-tag aliases first, so `zh-TW` resolves to `zh-hant` before the
        # subtag stripping below would have thrown the `TW` away.
        tag = _ISO3_TO_ISO1.get(tag, _TAG_ALIASES.get(tag, tag))
        if "-" in tag and tag != "zh-hant":
            parts = tag.split("-")
            base = parts[0]
            # `zh-Hant` is kept whole; every other script and region subtag is
            # noise as far as choosing a recognition dictionary goes.
            if base == "zh" and any(part in ("hant", "tw", "hk") for part in parts[1:]):
                tag = "zh-hant"
            else:
                tag = _ISO3_TO_ISO1.get(base, _TAG_ALIASES.get(base, base))

        if tag != "zh-hant" and (not tag.isalpha() or not 2 <= len(tag) <= 3):
            continue
        if tag not in seen:
            seen.append(tag)
    return tuple(seen)


def script_of(text: str) -> str:
    """The dominant Unicode script in a sample, as one of `_SCRIPT_LANGUAGE`'s keys.

    Used two ways: as the identifier of last resort when `fast-langdetect` is
    not installed, and as a sanity check on a tag it *did* return — a FastText
    label of `en` over a page of Arabic is a misclassification worth catching,
    and the script is not a matter of opinion.
    """
    counts: dict[str, int] = {}
    for character in text:
        if character.isspace() or not character.isalpha():
            continue
        name = _script_name(ord(character))
        counts[name] = counts.get(name, 0) + 1
    if not counts:
        return "latin"
    return max(counts.items(), key=lambda item: item[1])[0]


def _script_name(codepoint: int) -> str:
    for start, end, name in _SCRIPT_RANGES:
        if start <= codepoint <= end:
            return name
    return "latin"


def detect_languages(sample: str) -> tuple[str, ...]:
    """Identify a text sample's languages, most likely first.

    `fast-langdetect` with its bundled `lid.176.ftz` model, which is the whole
    reason it was chosen over `langdetect`: the weights are inside the wheel, so
    identification costs no network call and works under `OFFLINE_MODE`. The
    larger model would be downloaded on first use and is deliberately not asked
    for.

    Returns an empty tuple when there is nothing to go on. The caller falls back
    to the script, and then to the default — a chain in which every step is
    cheaper and less certain than the one before it.
    """
    text = " ".join(sample.split())
    if len(text) < 16:
        return ()

    text = text[:DETECTION_SAMPLE_CHARS]
    try:
        from fast_langdetect import detect
    except ImportError:  # pragma: no cover - a declared dependency
        logger.info("fast-langdetect is not installed; routing OCR by script alone")
        return ()

    try:
        # `lite` pins the bundled model. `auto` would fetch the 126MB one on
        # first use, which is a network call in the middle of a parse and a
        # violation of the offline promise.
        results = detect(text, model="lite", k=DETECTION_CANDIDATES)
    except Exception:
        logger.warning("language identification failed", exc_info=True)
        return ()

    candidates: list[str] = []
    for entry in results or []:
        if not isinstance(entry, dict):
            continue
        try:
            score = float(entry.get("score", 0.0))
        except (TypeError, ValueError):
            continue
        if score < DETECTION_MIN_SCORE:
            continue
        for tag in normalize_tags([str(entry.get("lang") or "")]):
            if tag not in candidates:
                candidates.append(tag)

    return tuple(candidates)


def plan_languages(
    *,
    requested: Sequence[str] | None = None,
    sample: str = "",
    model_dir: str | None = None,
    default_tesseract: str = "eng",
) -> LanguagePlan:
    """Resolve the phase's precedence hierarchy into one dispatch decision.

    `requested` is `settings.langList` from the job payload; when it holds
    anything usable it wins outright, because an operator who named the
    languages knows something the identifier cannot infer from a scan with no
    text layer. `sample` is whatever text the document has already yielded —
    the born-digital pages of a mixed filing, or the filename-free markdown of
    an earlier parse — and is what the identifier reads.
    """
    tags = normalize_tags(requested or ())
    source = "requested"

    if not tags:
        tags = detect_languages(sample)
        source = "detected"

    if not tags:
        tags = (_SCRIPT_LANGUAGE.get(script_of(sample), DEFAULT_LANGUAGE),) if sample else ()
        source = "script"

    if not tags:
        tags = (DEFAULT_LANGUAGE,)
        source = "default"
    elif source != "requested":
        tags = _reconcile_with_script(tags, sample)

    return _plan_for(tags, source=source, model_dir=model_dir, default_tesseract=default_tesseract)


def _reconcile_with_script(tags: tuple[str, ...], sample: str) -> tuple[str, ...]:
    """Promote the script's own language when the identifier disagreed with it.

    FastText scores a short, number-heavy or code-switched sample poorly and can
    return a confident Latin label for a page that is visibly not Latin. The
    script is not a judgement call, so when the two disagree the script wins the
    *primary* slot and the identifier's answer is kept behind it — a Chinese
    contract with an English preamble genuinely wants both dictionaries
    considered.
    """
    if not sample:
        return tags
    expected = _SCRIPT_LANGUAGE.get(script_of(sample))
    if expected is None or expected in tags:
        return tags
    if expected == DEFAULT_LANGUAGE:
        # Latin script under a non-Latin label is the one direction not to
        # correct: `tr`, `vi`, `pl` and `de` are all Latin-script, and demoting
        # a correct Turkish identification to English would undo the routing
        # this module exists for.
        return tags
    return (expected, *tags)


def _plan_for(
    tags: tuple[str, ...],
    *,
    source: str,
    model_dir: str | None,
    default_tesseract: str,
) -> LanguagePlan:
    primary = tags[0]
    unsupported: list[str] = []

    rapid_model: str | None = None
    rapid_keys: str | None = None
    prefer_tesseract = primary in _TESSERACT_ONLY

    if not prefer_tesseract:
        wanted = _RAPID_DICTIONARIES.get(primary)
        if wanted is not None:
            resolved = _resolve_weights(wanted, model_dir)
            if resolved is None:
                # The weights are not here. Tesseract's pack for this language
                # very likely is, and it is a better answer than reading a
                # Cyrillic page with a Latin dictionary.
                unsupported.append(primary)
                prefer_tesseract = True
            else:
                rapid_model, rapid_keys = resolved

    languages = _tesseract_languages(tags, default=default_tesseract)

    plan = LanguagePlan(
        tags=tags,
        source=source,
        tesseract_languages=languages,
        rapid_model_path=rapid_model,
        rapid_keys_path=rapid_keys,
        prefer_tesseract=prefer_tesseract,
        rtl=primary in RTL_LANGUAGES,
        unsupported=tuple(unsupported),
    )
    logger.info("OCR language routing resolved", extra=plan.describe())
    return plan


def _resolve_weights(names: tuple[str, str], model_dir: str | None) -> tuple[str, str] | None:
    """Locate an alternative recognition head, or `None` if it is not installed."""
    if not model_dir:
        return None
    directory = Path(model_dir)
    model = directory / names[0]
    keys = directory / names[1]
    if model.is_file() and keys.is_file():
        return str(model), str(keys)
    return None


def _tesseract_languages(tags: Sequence[str], *, default: str) -> str:
    """Traineddata names for a tag list, joined with `+`, most likely first.

    English is appended to a non-English list rather than replacing it. Real
    documents in every one of these languages carry English product names,
    units and citations, and Tesseract weighs the packs it is given rather than
    picking one — so the cost is a little speed and the benefit is that `ACME
    Corp.` inside a Turkish contract still comes out as `ACME Corp.`
    """
    packs: list[str] = []
    for tag in tags:
        pack = _TESSERACT_PACKS.get(tag)
        if pack is None and tag == DEFAULT_LANGUAGE:
            pack = "eng"
        if pack is None:
            # Latin-script and unlisted: the English traineddata's character
            # set covers it. See `_TESSERACT_PACKS`.
            pack = "eng"
        if pack not in packs:
            packs.append(pack)
    if not packs:
        return default
    if "eng" not in packs:
        packs.append("eng")
    return "+".join(packs)
