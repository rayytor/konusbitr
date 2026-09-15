"""The default build stays cleanly Apache-2.0 compatible.

This is a claim Konusbitr makes about itself, and a claim nobody can verify by
reading a dependency list — because the list that matters is the *transitive*
one, and a restrictively-licensed package usually arrives as somebody else's
dependency rather than as a line in `pyproject.toml`. The obvious choices for
this phase's work are the clearest example: PyMuPDF renders PDFs beautifully and
Marker is the best scanned-document pipeline available, and both are AGPL. They
belong behind the Compose `advanced` profile, where an operator opts into them
knowingly, and not in the image that `docker compose up` builds.

So the audit runs over the *installed environment*, not over the lockfile, and
it is a test rather than a CI-only script: a dependency added in a branch that
quietly changes the licensing of the default build should fail that branch, on
the machine where it was added, before it reaches anybody else.
"""

from __future__ import annotations

import json
import subprocess
import sys

import pytest

#: License families the default build may contain.
#:
#: Permissive, and compatible with redistributing this repository under
#: Apache-2.0. Matched as substrings against what a package declares, because
#: declarations are free text — the same license is spelled "Apache 2.0",
#: "Apache-2.0" and "Apache Software License" by three packages in this very
#: environment.
ALLOWED = (
    "apache",
    "mit",
    "bsd",
    "isc",
    "python software foundation",
    "psf",
    "historical permission notice",
    "mozilla public license 2.0",
    "mpl-2.0",
    "unlicense",
    "public domain",
    "zlib",
    "0bsd",
)

#: License families that must never appear in the default build.
#:
#: Checked explicitly as well as by the allowlist, so that a package declaring
#: "AGPL-3.0 OR Commercial" — which contains neither an allowed substring nor
#: an obviously refused one on a naive read — is refused for the right reason
#: and with the right message.
REFUSED = ("agpl", "gpl", "sspl", "commons clause", "non-commercial", "noncommercial")

#: Packages whose declared license is empty or unhelpful, checked by hand and
#: recorded here with what they actually ship under.
#:
#: An allowlist of *names* is the part of this test that can rot, so it is kept
#: as short as the facts allow and every entry says where its answer came from.
KNOWN_GOOD: dict[str, str] = {
    # Declares "UNKNOWN"; the wheel carries the Apache-2.0 text in its metadata
    # and the project is Apache-2.0 upstream.
    "konusbitr-worker": "Apache-2.0 (this package)",
}


def declared_licenses() -> list[dict[str, str]]:
    """Every installed distribution and what it says it is licensed under."""
    try:
        output = subprocess.run(
            [
                sys.executable,
                "-m",
                "piplicenses",
                "--format=json",
                "--with-system",
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=120,
        ).stdout
    except (OSError, subprocess.SubprocessError) as error:  # pragma: no cover
        pytest.skip(f"pip-licenses is not available here: {error}")

    return json.loads(output)


def is_permissive(license_text: str) -> bool:
    lowered = license_text.lower()
    if any(marker in lowered for marker in REFUSED):
        # LGPL is a GPL substring match and is a different question; it is not
        # in the default build either way, so the simple rule is kept simple.
        return False
    return any(marker in lowered for marker in ALLOWED)


class TestDefaultBuildLicensing:
    def test_no_restrictively_licensed_package_is_installed(self) -> None:
        """The assertion the `advanced` Compose profile exists to keep true."""
        offenders = [
            f"{entry['Name']} {entry['Version']}: {entry['License']}"
            for entry in declared_licenses()
            if entry["Name"].lower() not in KNOWN_GOOD
            and any(marker in entry["License"].lower() for marker in REFUSED)
        ]

        assert not offenders, (
            "restrictively-licensed packages in the default build:\n  "
            + "\n  ".join(offenders)
            + "\n\nAGPL and non-commercial dependencies belong behind the "
            "`advanced` Compose profile, never in the default image."
        )

    def test_every_package_declares_a_permissive_license(self) -> None:
        unknown = [
            f"{entry['Name']} {entry['Version']}: {entry['License']!r}"
            for entry in declared_licenses()
            if entry["Name"].lower() not in KNOWN_GOOD and not is_permissive(entry["License"])
        ]

        assert not unknown, (
            "packages whose license this audit could not place:\n  "
            + "\n  ".join(unknown)
            + "\n\nCheck each one. If it is permissive, add its spelling to "
            "ALLOWED or the package to KNOWN_GOOD with a note saying why."
        )

    @pytest.mark.parametrize(
        ("package", "expected"),
        [
            ("rapidocr-onnxruntime", "apache"),
            ("onnxruntime", "mit"),
            ("opencv-python-headless", "apache"),
            ("pytesseract", "apache"),
            ("deskew", "mit"),
            ("pypdfium2", "apache"),
            ("docling", "mit"),
            ("pillow", "mit"),
            # Phase 12.2's language identifier. MIT, and — the part that matters
            # more than the licence — it carries its FastText model inside its
            # own wheel, so identification costs no network call and works under
            # OFFLINE_MODE. `langdetect`, the obvious alternative, is Apache-2.0
            # and eighty times slower.
            ("fast-langdetect", "mit"),
        ],
    )
    def test_the_ocr_stack_is_what_the_phase_claims_it_is(
        self, package: str, expected: str
    ) -> None:
        """Named individually, because these are the ones the phase promises about.

        The blanket audit above would still pass if `rapidocr-onnxruntime` were
        swapped for something permissive but different, and the licensing claims
        in `phases/12.1-4-ocr-pipeline.md` and `phases/12.2-4-*.md` are about
        these specific packages.
        """
        entries = {entry["Name"].lower(): entry for entry in declared_licenses()}
        entry = entries.get(package.lower())

        assert entry is not None, f"{package} is not installed"
        assert expected in entry["License"].lower(), (
            f"{package} declares {entry['License']!r}, not {expected}"
        )
