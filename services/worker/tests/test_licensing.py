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
from pathlib import Path

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


class TestTheQuarantine:
    """The `advanced` profile's packages are absent, and stay absent.

    Phase 12.3's licensing work is not really about *adding* the restrictive
    parsers — it is about making their absence from the default build a
    property something checks rather than a fact somebody remembers. These are
    the assertions that do the checking.
    """

    @pytest.mark.parametrize("package", ["pymupdf", "fitz", "surya-ocr", "marker-pdf"])
    def test_a_quarantined_package_is_not_installed(self, package: str) -> None:
        installed = {entry["Name"].lower() for entry in declared_licenses()}
        assert package.lower() not in installed, (
            f"{package} is in the default environment. It belongs in "
            "docker/advanced-requirements.txt, installed only by the "
            "`worker-advanced` Docker stage. See docs/licensing.md."
        )

    def test_they_are_not_in_the_projects_dependency_resolution(self) -> None:
        """Not merely uninstalled — **unresolvable from this project at all**.

        They were a `pyproject.toml` extra first, and could not stay one: both
        pin `pillow<11`, the default build needs `pillow>=11`, and uv resolves
        extras together with the base dependencies. As an extra they therefore
        got to decide which Pillow the *Apache-2.0* image ships, which is the
        quarantine leaking in the one direction it must never leak.

        So the pins live in a requirements file that nothing but one Dockerfile
        stage reads, and the lockfile must never mention them.
        """
        lockfile = Path(__file__).resolve().parents[1] / "uv.lock"
        if not lockfile.is_file():  # pragma: no cover - a broken checkout
            pytest.skip("uv.lock is missing")

        text = lockfile.read_text(encoding="utf-8").lower()
        for package in ("pymupdf", "surya-ocr", "marker-pdf"):
            assert f'name = "{package}"' not in text, (
                f"{package} is in uv.lock, so it constrains the default build's "
                "resolution. It belongs in docker/advanced-requirements.txt."
            )

    def test_the_requirements_file_pins_what_it_declares(self) -> None:
        """An operator who opts in gets pinned versions, not an unpinned install
        of an AGPL package into the container that is meant to be the carefully
        quarantined one."""
        requirements = Path(__file__).resolve().parents[3] / "docker" / "advanced-requirements.txt"
        if not requirements.is_file():  # pragma: no cover - a broken checkout
            pytest.skip("the advanced requirements file is missing")

        pins = [
            line.strip()
            for line in requirements.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        assert pins, "the advanced requirements file declares nothing"
        assert all("==" in pin for pin in pins), f"an unpinned advanced package: {pins}"

    def test_nothing_imports_them_at_module_scope(self) -> None:
        """A top-level import of any of these would make the whole worker fail
        to start on a default build — which is every build.

        `konusbitr_worker.parse.advanced` is the one module that names them, and
        it names them as *strings*, inside functions.
        """
        source_root = Path(__file__).resolve().parents[1] / "src" / "konusbitr_worker"
        offenders: list[str] = []
        for path in source_root.rglob("*.py"):
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                stripped = line.strip()
                if not stripped.startswith(("import ", "from ")):
                    continue
                if any(
                    stripped.startswith(f"{form} {package}")
                    for form in ("import", "from")
                    for package in ("fitz", "pymupdf", "surya", "marker")
                ):
                    offenders.append(f"{path.name}:{number}: {stripped}")

        assert not offenders, "a quarantined parser is imported directly:\n  " + "\n  ".join(
            offenders
        )

    def test_the_boundary_module_reports_absence_rather_than_raising(self) -> None:
        from konusbitr_worker.parse.advanced import advanced_parsers_available

        available = advanced_parsers_available()
        assert available.any is False

    def test_asking_for_one_names_the_profile_rather_than_the_import_error(
        self,
    ) -> None:
        """A caller gets a message about a licensing boundary, not an
        `ImportError` from three frames deeper that a reader has to recognise as
        one."""
        from konusbitr_worker.parse.advanced import (
            AdvancedParserUnavailable,
            require_advanced_parsers,
        )

        with pytest.raises(AdvancedParserUnavailable) as raised:
            require_advanced_parsers("fitz")

        message = str(raised.value)
        assert "advanced" in message
        assert "docs/licensing.md" in message
