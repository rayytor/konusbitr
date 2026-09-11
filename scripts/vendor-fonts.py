#!/usr/bin/env -S uv run --quiet --with "fonttools[woff]>=4.60" --python 3.12 --script
"""Vendor the LINE Seed JP web font into `apps/web/src/fonts`.

LINE Seed JP is a full CJK family — 3.6 MB per weight — and `next/font/google`
does not carry it, so we subset it ourselves and self-host the result. Two
reasons to self-host rather than link to Google's CDN: Konusbitr is meant to run
air-gapped, and a self-hosted deployment should not be reporting its users'
addresses to a third party on every page load.

We keep Latin and Latin Extended-A, which together cover English, Turkish and
most European diacritics. Text outside that range falls through to the system
sans stack declared in `globals.css`.

Instrument Serif is *not* vendored here: it is in `next/font/google`, which
downloads and self-hosts it at build time, so it is already offline-safe.

Run from the repository root:

    ./scripts/vendor-fonts.py

The output is committed. Re-run it only to pick up a new upstream release.

LINE Seed JP is licensed under the SIL Open Font License 1.1 — see
`apps/web/src/fonts/README.md`.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.request

# Latin plus Latin Extended-A, matching the ranges Google serves for the
# "latin" and "latin-ext" subsets.
UNICODES = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD,U+0100-024F,U+0259,U+1E00-1EFF,U+2C60-2C7F,U+A720-A7FF"

# An old UA makes the CSS API hand back a single unsubsetted TrueType file
# instead of a hundred woff2 slices.
LEGACY_UA = "Mozilla/4.0"

OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / "apps/web/src/fonts"

WEIGHTS = {400: "regular", 700: "bold"}


def fetch(url: str, user_agent: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": user_agent})
    with urllib.request.urlopen(request) as response:
        return response.read()


def source_url(weight: int) -> str:
    css = fetch(
        f"https://fonts.googleapis.com/css2?family=LINE+Seed+JP:wght@{weight}",
        LEGACY_UA,
    ).decode()
    match = re.search(r"url\((https://[^)]+\.ttf)\)", css)
    if match is None:
        raise SystemExit(f"no TrueType source in the CSS for weight {weight}")
    return match.group(1)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for weight, label in WEIGHTS.items():
            url = source_url(weight)
            full = pathlib.Path(tmp) / f"{label}.ttf"
            full.write_bytes(fetch(url, LEGACY_UA))
            out = OUT_DIR / f"line-seed-jp-{label}.woff2"
            subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "fontTools.subset",
                    str(full),
                    f"--unicodes={UNICODES}",
                    "--layout-features=*",
                    "--flavor=woff2",
                    f"--output-file={out}",
                ],
                check=True,
            )
            print(f"{out.relative_to(OUT_DIR.parents[3])}: {out.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
