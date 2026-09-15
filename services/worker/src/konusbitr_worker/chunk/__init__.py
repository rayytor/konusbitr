"""Turning a parse artifact into retrievable chunks.

Two modules, one seam. :mod:`konusbitr_worker.chunk.elements` reads the parse
artifact's JSON — the same JSON whether it has just come out of Docling or out
of ``parse_results.contents`` from a parse that happened weeks ago — and
:mod:`konusbitr_worker.chunk.chunker` decides where the boundaries go.

That split is what makes a cached parse re-chunkable without re-parsing, which
is the whole point of the docId cache: the chunker or the embedding model can
change, a ``reindex`` job re-runs this package over the stored artifact, and
Docling is never loaded.
"""

from __future__ import annotations

from konusbitr_worker.chunk.chunker import (
    MAX_CHUNK_CONTEXT_TOKENS,
    SECTION_PATH_SEPARATOR,
    TRUNCATION_MARKER,
    Chunk,
    ChunkingOptions,
    chunk_elements,
)
from konusbitr_worker.chunk.elements import (
    SourceElement,
    elements_from_contents,
    figure_elements,
)

__all__ = [
    "MAX_CHUNK_CONTEXT_TOKENS",
    "SECTION_PATH_SEPARATOR",
    "TRUNCATION_MARKER",
    "Chunk",
    "ChunkingOptions",
    "SourceElement",
    "chunk_elements",
    "elements_from_contents",
    "figure_elements",
]
