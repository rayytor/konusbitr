"""The quarantine boundary for the restrictively-licensed parsers.

**Nothing in this module is installed by the default build**, and that is the
point. PyMuPDF is AGPL-3.0, Surya is GPL-3.0 and Marker adds a non-commercial
restriction on top of one; all three are genuinely excellent and all three would
change the licence of any image that contained them. `docs/licensing.md` sets
out the bargain in full.

So this file is the one place in `konusbitr_worker` that knows those packages
exist, and it exists to enforce three properties:

**Nothing imports them at module scope.** An import at the top of any module in
this package would make the whole worker fail to start on a default build, which
is every build. Every import here is inside a function.

**The default build never pays to find out.** `KONUSBITR_ADVANCED_PARSERS` is
set by the `worker-advanced` Dockerfile stage and by nothing else, so
:func:`advanced_parsers_available` answers without an import attempt in the case
that is overwhelmingly common. The import is the confirmation, not the question.

**Absence is reported, never guessed at.** A caller asking for a capability the
image does not have gets :class:`AdvancedParserUnavailable` with a message that
names the profile and the document to read — not an `ImportError` from three
frames deeper, and not a silent fallback that leaves somebody believing they
built the advanced image when they did not.

Phase 12.3 wires the boundary and not a pipeline through it. The default build's
own tiers cover what the phase promises — Docling for born-digital layout, the
Phase 12.1/12.2 OCR tier for scans, and the VLM tier for structure and reading
order — and none of them needs a copyleft dependency. The functions below are
the seam a later phase reaches through, and the licensing test is what keeps
that seam from quietly becoming the default.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from konusbitr_worker.log import get_logger

__all__ = [
    "ADVANCED_ENV_FLAG",
    "ADVANCED_PACKAGES",
    "AdvancedParserUnavailable",
    "AdvancedParsers",
    "advanced_parsers_available",
    "require_advanced_parsers",
]

logger = get_logger("konusbitr.worker.parse.advanced")

#: Set to ``true`` by the ``worker-advanced`` Dockerfile stage and by nothing
#: else. Announced in the environment rather than inferred from an import,
#: because the overwhelmingly common answer is "no" and the cheapest way to give
#: it is not to try.
ADVANCED_ENV_FLAG = "KONUSBITR_ADVANCED_PARSERS"

#: What the ``advanced`` extra installs, and what each one is licensed under.
#: Kept here as data so the message a caller sees names the actual packages and
#: cannot drift from `pyproject.toml` without somebody noticing.
ADVANCED_PACKAGES: dict[str, str] = {
    "fitz": "PyMuPDF, AGPL-3.0",
    "surya": "Surya, GPL-3.0",
    "marker": "Marker, GPL-3.0 with a commercial restriction",
}


class AdvancedParserUnavailable(RuntimeError):
    """An advanced parser was asked for on an image that does not carry one."""

    def __init__(self, package: str) -> None:
        description = ADVANCED_PACKAGES.get(package, package)
        super().__init__(
            f"{description} is not installed. It is part of the `advanced` Compose "
            "profile, which is deliberately not in the default image: it would change "
            "the licence of the build. Run `WORKER_REPLICAS=0 docker compose --profile "
            "advanced up`, and read docs/licensing.md first — an image containing it "
            "may not be redistributed under Apache-2.0."
        )
        self.package = package


@dataclass(frozen=True, slots=True)
class AdvancedParsers:
    """Which of the extras this image actually has, resolved once."""

    pymupdf: bool = False
    surya: bool = False
    marker: bool = False

    @property
    def any(self) -> bool:
        return self.pymupdf or self.surya or self.marker

    def to_json(self) -> dict[str, bool]:
        return {"pymupdf": self.pymupdf, "surya": self.surya, "marker": self.marker}


def advanced_parsers_available() -> AdvancedParsers:
    """What the running image carries. Cheap and truthful on a default build.

    The environment flag is checked first and short-circuits, so the default
    image answers without three failed imports. On an advanced image the flag
    gets us as far as "these were meant to be here" and the imports confirm it —
    a build that set the flag and then failed to install something must report
    the absence rather than the intent.
    """
    if os.environ.get(ADVANCED_ENV_FLAG, "").strip().lower() != "true":
        return AdvancedParsers()

    return AdvancedParsers(
        pymupdf=_importable("fitz"),
        surya=_importable("surya"),
        marker=_importable("marker"),
    )


def require_advanced_parsers(package: str) -> object:
    """Import one of the extras, or raise :class:`AdvancedParserUnavailable`.

    The single door. A caller writes ``fitz = require_advanced_parsers("fitz")``
    and gets either the module or a message naming the profile — never a bare
    `ImportError` that a reader has to recognise as a licensing boundary rather
    than a broken install.
    """
    import importlib

    try:
        return importlib.import_module(package)
    except ImportError as error:
        raise AdvancedParserUnavailable(package) from error


def _importable(name: str) -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):  # pragma: no cover - a broken partial install
        return False
