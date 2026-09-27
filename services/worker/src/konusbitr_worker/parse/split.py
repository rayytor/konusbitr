"""Cutting a document into several documents.

Phase 13's `split` job. The *decision* — which pages, called what — is made on
the TypeScript side, where a request body and the parse artifact's section tree
both live; what arrives here is a list of ranges, and what this module does is
the part only Python can do: open a PDF, write another one, and derive the new
document's parse from the old one's rather than reading the pages again.

That last part is the whole economy of the feature. The parent's pages have
already been parsed — the API waits for a finished artifact before it enqueues
anything — so an output covering pages 40 to 60 does not need OCR, a layout
model or a vision call. It needs the parent's elements for those pages with
their page numbers shifted, which is arithmetic. A split that re-parsed would
charge a document's full parse cost once per output and produce, at best, the
same elements.

`pypdf` rather than PyMuPDF, and that is a licensing decision rather than a
technical one: PyMuPDF is AGPL and lives only behind the `advanced` Compose
profile, and page-range extraction is one of the few things the permissively
licensed library does just as well. See `docs/licensing.md`.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

from pypdf import PdfReader, PdfWriter

from konusbitr_worker.contracts import JobErrorCode, SplitRange
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.log import get_logger

__all__ = ["SlicedDocument", "derive_artifact", "slice_ranges"]

logger = get_logger("konusbitr.worker.split")


@dataclass(slots=True)
class SlicedDocument:
    """One output: its bytes, its identity, and where it came from."""

    #: 1-based, inclusive, in the *parent's* numbering. Both the answer a caller
    #: gets back and the key the derived artifact is built from.
    pages: list[int]
    name: str
    content: bytes
    content_hash: str
    page_count: int


def slice_ranges(source: Path, ranges: list[SplitRange]) -> list[SlicedDocument]:
    """Write one PDF per range.

    Each output is hashed as it is produced, because the hash is half of the
    new document's identity and half of its docId cache key — and hashing the
    bytes we just wrote is the only way to be sure it describes what was
    actually stored.

    A range whose pages are all missing from the source is skipped rather than
    raised on. The API validates every range against the parent's page count
    before enqueueing, so reaching this means the file disagrees with what was
    parsed — and losing one output of twelve is a better outcome than failing
    the whole split.
    """
    try:
        reader = PdfReader(str(source))
    except Exception as error:
        raise JobFailure(
            JobErrorCode.corrupt_document,
            "That document could not be opened for splitting.",
        ) from error

    if reader.is_encrypted:
        raise JobFailure(
            JobErrorCode.encrypted_document,
            "An encrypted document cannot be split.",
        )

    total = len(reader.pages)
    outputs: list[SlicedDocument] = []

    for entry in ranges:
        # Clamped rather than trusted: the payload is a message, not an
        # authority, and this is the one place where an out-of-range index
        # would be an IndexError deep inside a third-party library.
        start = max(1, entry.start)
        end = min(total, entry.end)
        if end < start:
            logger.warning(
                "skipping an empty split range",
                extra={"start": entry.start, "end": entry.end, "pages": total},
            )
            continue

        writer = PdfWriter()
        for page_no in range(start, end + 1):
            writer.add_page(reader.pages[page_no - 1])

        buffer = BytesIO()
        writer.write(buffer)
        content = buffer.getvalue()

        outputs.append(
            SlicedDocument(
                pages=list(range(start, end + 1)),
                name=entry.name,
                content=content,
                content_hash=hashlib.sha256(content).hexdigest(),
                page_count=end - start + 1,
            )
        )

    if not outputs:
        raise JobFailure(
            JobErrorCode.invalid_payload,
            "None of the requested page ranges exist in that document.",
        )

    return outputs


def derive_artifact(
    parent_contents: dict[str, Any],
    parent_markdown: str | None,
    pages: list[int],
) -> tuple[dict[str, Any], str]:
    """Build an output's parse artifact from its parent's.

    Two things are renumbered and one is dropped, and each for its own reason.

    **Elements and pages are renumbered.** An output's pages are 1..n whatever
    the parent called them, so every `page` becomes `page - offset`. Leaving
    them alone would produce a document whose citations point at page 47 of a
    twelve-page file — which the Phase 10 verifier would reject, correctly, and
    which would look like a retrieval bug rather than an arithmetic one.

    **Thumbnails are dropped.** A thumbnail key names an object under the
    *parent's* storage prefix, and an output pointing at it would break the
    moment the parent is deleted. The pages are simply thumbnail-less until
    something renders them, which the viewer already handles — a rail image is
    an optimisation and a dangling key is not.

    **Images are dropped** for the same reason: a figure's object lives under
    the parent's prefix. A split is not the place to copy bitmaps around, and
    an output that needs its figures can be reparsed.

    The markdown is rebuilt from the retained elements rather than sliced out of
    the parent's string, because markdown has no page boundaries in it — the one
    thing that cannot be recovered from it is where a page ended.
    """
    keep = set(pages)
    offset = min(pages) - 1

    elements: list[dict[str, Any]] = []
    for element in parent_contents.get("contents") or []:
        if not isinstance(element, dict):
            continue
        page = element.get("page")
        if not isinstance(page, int) or page not in keep:
            continue
        elements.append({**element, "page": page - offset})

    page_rows: list[dict[str, Any]] = []
    for page_row in parent_contents.get("pages") or []:
        if not isinstance(page_row, dict):
            continue
        page_no = page_row.get("pageNo")
        if not isinstance(page_no, int) or page_no not in keep:
            continue
        page_rows.append({**page_row, "pageNo": page_no - offset, "thumbnailKey": None})

    markdown = "\n\n".join(
        str(element.get("markdown") or element.get("text") or "").strip()
        for element in elements
        if str(element.get("markdown") or element.get("text") or "").strip()
    )

    contents = {
        "pageCount": len(pages),
        "contents": elements,
        "pages": page_rows,
        "images": [],
        "timings": {},
    }

    return contents, markdown
