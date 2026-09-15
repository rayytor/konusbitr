#!/usr/bin/env -S uv run --quiet --with "fonttools>=4.60" --python 3.12 --script
"""Subset and commit the fonts the multilingual fixtures are typeset with.

`fixtures/generate.py` produces every PDF in the corpus and nothing is scraped,
which is what lets a test assert what a page *says* rather than record what a
recogniser returned. Phase 12.2 extends that corpus past Latin script, and a
Turkish, Arabic, Chinese or Japanese page needs a font that has the glyphs — so
one has to come from somewhere.

Taking it from the developer's machine would break the property the corpus is
built on. `fixtures/generate.py` is byte-stable precisely so that a diff on
those files means the corpus moved; a system font would make it mean "this
person has a different version of Noto installed", and the one fixture that
always shows up in `git status` is the one nobody reads diffs of.

So the fonts are vendored, and subset to the characters the fixtures actually
use — which turns a 20MB CJK family into a few kilobytes that belong in a
repository. The Arabic subset keeps its `GSUB`/`GPOS` tables, because Arabic is
contextually shaped and a subset without them renders a row of disconnected
letters that no recogniser and no reader would accept as Arabic.

Noto is licensed under the SIL Open Font License 1.1, which permits
redistribution of subsets. See `fixtures/fonts/README.md`.

Run from the repository root, on a machine with the Noto fonts installed:

    ./scripts/vendor-fixture-fonts.py

The output is committed. Re-run it only to widen the character set or to pick up
a new upstream release — and expect the fixture PDFs to change when you do.
"""

from __future__ import annotations

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "fixtures" / "fonts"

sys.path.insert(0, str(ROOT / "fixtures"))

#: Where each source font is looked for. Several candidates per family because
#: distributions disagree about the path and about `.ttf` versus `.ttc`.
SOURCES: dict[str, tuple[tuple[str, ...], str]] = {
    # name: (candidate paths, apt package that provides it)
    "NotoSans-subset.ttf": (
        (
            "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
            "/usr/share/fonts/noto/NotoSans-Regular.ttf",
            "/usr/share/fonts/TTF/NotoSans-Regular.ttf",
        ),
        "fonts-noto-core",
    ),
    # Sans rather than Naskh. Both are Noto and both are correct Arabic; the
    # shipped `ara` traineddata reads this one markedly better, and a fixture
    # the recogniser cannot read measures nothing about the pipeline.
    "NotoSansArabic-subset.ttf": (
        (
            "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf",
            "/usr/share/fonts/noto/NotoSansArabic-Regular.ttf",
        ),
        "fonts-noto-core",
    ),
    "NotoSansCJK-subset.ttf": (
        (
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
        ),
        "fonts-noto-cjk",
    ),
}


def resolve(candidates: tuple[str, ...]) -> pathlib.Path | None:
    for candidate in candidates:
        path = pathlib.Path(candidate)
        if path.is_file():
            return path
    return None


def subset(source: pathlib.Path, target: pathlib.Path, characters: str) -> None:
    """Cut a font down to the characters the fixtures use, keeping its shaping.

    `--layout-features='*'` is the load-bearing flag. fonttools drops layout
    features the subsetted glyph set no longer needs, and for Arabic that is
    exactly the joining behaviour: without it every letter renders in its
    isolated form and the page is not Arabic any more.
    """
    command = [
        sys.executable,
        "-m",
        "fontTools.subset",
        str(source),
        f"--text={characters}",
        "--layout-features=*",
        "--notdef-outline",
        "--recommended-glyphs",
        "--flavor=",
        f"--output-file={target}",
    ]
    if source.suffix == ".ttc":
        command.insert(3, "--font-number=0")
    subprocess.run([part for part in command if part != "--flavor="], check=True)


def main() -> int:
    from fixture_text import FIXTURE_CHARACTERS

    OUTPUT.mkdir(parents=True, exist_ok=True)
    missing: list[str] = []

    for name, (candidates, package) in SOURCES.items():
        source = resolve(candidates)
        if source is None:
            missing.append(f"  {name}: install {package} (looked in {', '.join(candidates)})")
            continue
        subset(source, OUTPUT / name, FIXTURE_CHARACTERS[name])
        print(f"{name}: {(OUTPUT / name).stat().st_size:>8,} bytes  ← {source}")

    if missing:
        print("\nmissing source fonts:\n" + "\n".join(missing), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
