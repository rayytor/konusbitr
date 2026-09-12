"""Page thumbnails, and the keys they are stored under.

Two things matter here and neither is image quality. The **key** is built from
generated ids and an integer and from nothing a user chose, which is the rule
that keeps a filename out of an object path. And the thumbnail is of the page a
*reader* sees — rotation applied — so that a picture and the bounding boxes
drawn on it describe the same page.
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest

from konusbitr_worker.parse.thumbnails import (
    THUMBNAIL_CONTENT_TYPE,
    render_thumbnails,
    thumbnail_key,
)


def test_a_key_is_built_only_from_ids_and_a_page_number() -> None:
    key = thumbnail_key("org_abc", "doc_xyz", 7)

    assert key == "orgs/org_abc/documents/doc_xyz/thumbnails/00007.webp"


def test_page_numbers_are_zero_padded_so_a_listing_sorts() -> None:
    keys = [thumbnail_key("org_a", "doc_b", page) for page in (2, 10, 100)]

    assert keys == sorted(keys)


def test_every_page_is_rendered_as_a_webp(fixtures_dir: Path) -> None:
    rendered = list(render_thumbnails(fixtures_dir / "clean-text-10p.pdf", max_edge=400))

    assert [page_no for page_no, _image in rendered] == list(range(1, 11))
    for _page_no, image in rendered:
        assert image[:4] == b"RIFF" and image[8:12] == b"WEBP"
    assert THUMBNAIL_CONTENT_TYPE == "image/webp"


def test_the_longest_edge_is_the_one_that_is_bounded(fixtures_dir: Path) -> None:
    from PIL import Image

    for _page_no, body in render_thumbnails(fixtures_dir / "clean-text-10p.pdf", max_edge=800):
        with Image.open(BytesIO(body)) as image:
            assert max(image.size) == pytest.approx(800, abs=2)
            assert min(image.size) < 800


def test_a_rotated_page_is_rendered_landscape(fixtures_dir: Path) -> None:
    """The thumbnail agrees with the coordinates, which is the whole point.

    A thumbnail of the *stored* page would be portrait while every bbox on it
    was measured against a landscape frame — a highlight in the right place on
    a picture turned the wrong way.
    """
    from PIL import Image

    rendered = dict(render_thumbnails(fixtures_dir / "rotated-a4.pdf", max_edge=600))

    with Image.open(BytesIO(rendered[1])) as upright:
        assert upright.height > upright.width
    with Image.open(BytesIO(rendered[2])) as rotated:
        assert rotated.width > rotated.height


def test_only_the_requested_pages_are_rendered(fixtures_dir: Path) -> None:
    rendered = list(
        render_thumbnails(fixtures_dir / "clean-text-10p.pdf", max_edge=200, pages=[3, 5])
    )

    assert [page_no for page_no, _image in rendered] == [3, 5]
