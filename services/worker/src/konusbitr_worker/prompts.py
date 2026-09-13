"""Loading the versioned prompt files.

Prompts live in ``packages/ai/prompts/`` and never as inline string literals, so
that a change in an eval score can be attributed to a change in a prompt. The
worker image ships only ``services/worker/``, so ``pnpm codegen`` copies those
files into ``konusbitr_worker/prompts/`` and CI fails on drift — the same
arrangement that keeps ``contracts.py`` honest.
"""

from __future__ import annotations

from functools import cache
from pathlib import Path

__all__ = ["PromptNotFoundError", "load_prompt"]

PROMPTS_DIR = Path(__file__).parent / "prompts"


class PromptNotFoundError(RuntimeError):
    """A prompt was asked for by a name no file carries."""

    def __init__(self, name: str, directory: Path) -> None:
        super().__init__(
            f"no prompt named {name!r} in {directory}. Prompts are generated from "
            "packages/ai/prompts/ by `pnpm codegen`; add the file there and regenerate."
        )


@cache
def load_prompt(name: str) -> str:
    """Read a prompt by name, with or without its ``.md`` suffix.

    Cached: a prompt file is immutable once it has an eval result attached to
    it — a change gets a new version number and a new file.
    """
    filename = name if name.endswith(".md") else f"{name}.md"
    path = PROMPTS_DIR / filename
    if not path.is_file():
        raise PromptNotFoundError(name, PROMPTS_DIR)
    return path.read_text(encoding="utf-8").strip()
