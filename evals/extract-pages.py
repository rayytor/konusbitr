"""Dump the per-page text of the fixture corpus for the retrieval eval harness.

The eval harness needs real passages with real page numbers. It could not get
them by re-deriving the fixture content in TypeScript — a second copy of the
corpus drifts from the first, and a golden set whose expected pages are guessed
measures nothing. So the text comes out of the PDFs themselves, here, once, into
a file the harness reads.

`pypdfium2` is already a worker dependency and is permissively licensed, so this
adds nothing to the default build's license surface.

Regenerate with:

    uv run --project services/worker python evals/extract-pages.py

The output is sorted and indented, so a diff on it means the corpus moved.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PDF_DIR = ROOT / "fixtures" / "pdf"
OUTPUT = ROOT / "evals" / "golden" / "pages.json"

#: The readable fixtures. The scan, the encrypted file and the truncated one are
#: refusals rather than corpora, and have no text to retrieve over.
DOCUMENTS = (
    "clean-text-10p",
    "text-50p",
    "tables-financial",
    "two-column-paper",
    "rotated-a4",
)


def extract(name: str) -> list[dict[str, object]]:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(PDF_DIR / f"{name}.pdf"))
    pages: list[dict[str, object]] = []
    for index in range(len(pdf)):
        page = pdf[index]
        textpage = page.get_textpage()
        raw = textpage.get_text_bounded()
        # Collapse the soft line breaks reportlab's fixed-width wrapping leaves
        # behind, but keep paragraph breaks: a passage is what gets embedded.
        text = " ".join(line.strip() for line in raw.splitlines() if line.strip())
        width, height = page.get_size()
        pages.append(
            {
                "page": index + 1,
                "width": round(width, 2),
                "height": round(height, 2),
                "rotation": page.get_rotation(),
                "text": text,
            }
        )
    return pages


def main() -> int:
    corpus = {name: extract(name) for name in DOCUMENTS}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(corpus, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    for name, pages in corpus.items():
        characters = sum(len(str(page["text"])) for page in pages)
        print(f"{name}: {len(pages):>3} pages, {characters:>7,} characters")
    print(f"\nwritten to {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
