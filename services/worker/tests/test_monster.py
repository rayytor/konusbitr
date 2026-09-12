"""The 500-page monster.

Generated rather than committed. A 500-page PDF is twenty megabytes of
repository that no human will ever open, and the thing it proves — that the
pipeline's memory ceiling is a function of *page size* rather than *page count*
— does not depend on the pages being the same 500 pages every time.

What it actually guards is the shape of two loops. Thumbnails are rendered by a
generator and uploaded in batches, so a 500-page document never holds 500
decoded bitmaps at once; elements are appended as they are normalized. A
refactor that "simplifies" either into a list comprehension turns a large
document from slow into fatal, and this is the test that says so.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from konusbitr_worker.parse.inspect import inspect_pdf
from konusbitr_worker.parse.thumbnails import render_thumbnails
from konusbitr_worker.settings import Settings

pytestmark = pytest.mark.slow

MONSTER_PAGES = 500


@pytest.fixture(scope="module")
def monster(tmp_path_factory: pytest.TempPathFactory) -> Path:
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from fixtures.generate import clean_text

    path = tmp_path_factory.mktemp("monster") / "monster-500p.pdf"
    clean_text(path, pages=MONSTER_PAGES, title="Five Hundred Pages")
    return path


def test_five_hundred_pages_are_inspected_in_one_pass(monster: Path) -> None:
    """Page geometry and text coverage for every page, without opening it twice."""
    inspection = inspect_pdf(monster)

    assert inspection.page_count == MONSTER_PAGES
    assert len(inspection.pages) == MONSTER_PAGES
    assert [page.page_no for page in inspection.pages] == list(range(1, MONSTER_PAGES + 1))
    # Born-digital text throughout, so nothing is mistaken for a scan.
    assert min(inspection.coverage) > 0.1


def test_thumbnails_are_produced_lazily(monster: Path, settings: Settings) -> None:
    """One bitmap in memory at a time, whatever the page count.

    Asserted by consuming three pages of a 500-page document and stopping. A
    generator satisfies this in milliseconds; anything that rendered the whole
    document before yielding its first page would take the better part of a
    minute, and would be exactly as correct.
    """
    renderer = render_thumbnails(monster, max_edge=settings.worker_thumbnail_max_edge)

    rendered = [next(renderer) for _ in range(3)]
    renderer.close()

    assert [page_no for page_no, _image in rendered] == [1, 2, 3]
    assert all(image[:4] == b"RIFF" for _page_no, image in rendered)
