"""Describing a figure, and every way that is allowed not to happen.

The captioning path has one happy case and four supported unhappy ones, and the
unhappy ones are the point: a stack with no vision model is the default state of
`docker compose up`, an upload that did not ask for `llm` must not be sent to a
provider, a figure with nothing in it must not be indexed as if it had
something, and a provider outage must not fail a parse that otherwise succeeded.

The router is a double throughout. What is being tested is the policy around the
call, not the call — `konusbitr_worker.ai.vision` is the module that knows how to
talk to a provider and it is tested with the other routers.
"""

from __future__ import annotations

from typing import Any

import pytest

from konusbitr_worker.parse.captions import NO_CONTENT_SENTINEL, caption_images
from konusbitr_worker.parse.geometry import BBox
from konusbitr_worker.parse.images import ExtractedImage, ImageCandidate

pytestmark = pytest.mark.asyncio


class FakeVisionRouter:
    """Answers every image with the same thing, and records what it was shown."""

    model_name = "fake/vision"

    def __init__(self, answer: str | Exception = "A bar chart. Revenue by region.") -> None:
        self._answer = answer
        self.calls: list[dict[str, Any]] = []

    async def describe(self, **kwargs: Any) -> str:
        self.calls.append(kwargs)
        if isinstance(self._answer, Exception):
            raise self._answer
        return self._answer


def figure(index: int = 1) -> tuple[ExtractedImage, ImageCandidate]:
    bbox = BBox(72.0, 268.0, 468.0, 532.0)
    return (
        ExtractedImage(
            id=f"img_{index:03d}",
            page=1,
            bbox=bbox,
            width=792,
            height=528,
            storage_key=f"orgs/org_a/documents/doc_a/images/{index}.png",
        ),
        ImageCandidate(page=1, bbox=bbox, width=792, height=528, data=b"\x89PNG-bytes"),
    )


async def test_a_figure_is_captioned_and_the_caption_is_attached() -> None:
    router = FakeVisionRouter()
    images = [figure()]

    assert await caption_images(images, router=router) == 1
    assert images[0][0].caption == "A bar chart. Revenue by region."
    assert router.calls[0]["image"] == b"\x89PNG-bytes"


async def test_no_vision_model_leaves_the_figure_uncaptioned_rather_than_failing() -> None:
    """The default state of `docker compose up`, and it is a supported one.

    The figure is still extracted, stored and located; it is simply not
    searchable. Failing the job instead would make an optional capability a hard
    dependency.
    """
    images = [figure()]

    assert await caption_images(images, router=None) == 0
    assert images[0][0].caption is None


async def test_a_provider_failure_costs_the_caption_and_not_the_document() -> None:
    """A rate limit, an outage, a model that refuses one image.

    The document is worth having without its chart descriptions; it is not worth
    losing over them.
    """
    images = [figure()]
    router = FakeVisionRouter(RuntimeError("429"))

    assert await caption_images(images, router=router) == 0
    assert images[0][0].caption is None


async def test_one_failure_does_not_take_the_other_figures_with_it() -> None:
    class Flaky(FakeVisionRouter):
        async def describe(self, **kwargs: Any) -> str:
            self.calls.append(kwargs)
            if len(self.calls) == 1:
                raise RuntimeError("429")
            return "A line chart showing headcount rising through the year."

    images = [figure(1), figure(2)]
    assert await caption_images(images, router=Flaky()) == 1
    assert {image.caption is None for image, _ in images} == {True, False}


async def test_an_empty_figure_is_not_indexed_as_if_it_had_content() -> None:
    """The prompt asks for a fixed sentinel rather than for "say so".

    A free-form refusal would be stored as a description, and "I cannot see any
    meaningful content in this image" is a passage that retrieves for questions
    about images.
    """
    images = [figure()]
    router = FakeVisionRouter(NO_CONTENT_SENTINEL)

    assert await caption_images(images, router=router) == 0
    assert images[0][0].caption is None


async def test_a_one_word_answer_is_rejected() -> None:
    """A model that did not look.

    Storing it would put a chunk in the index whose entire content is the word
    "Chart", which retrieves for every question about a figure and answers none.
    """
    images = [figure()]

    assert await caption_images(images, router=FakeVisionRouter("Chart.")) == 0
    assert images[0][0].caption is None


async def test_nothing_to_caption_makes_no_call() -> None:
    router = FakeVisionRouter()
    assert await caption_images([], router=router) == 0
    assert router.calls == []
