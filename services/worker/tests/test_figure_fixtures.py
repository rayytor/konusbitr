"""Figures, end to end: extracted, stored, captioned and made retrievable.

The fixture is `figures-chart.pdf` — a born-digital report carrying one real bar
chart, a 64-pixel logo and a 600-by-4 rule, with the furniture drawn *after* the
chart so a filter that simply kept the first image would be caught.

The vision model is a double. What is being tested is the pipeline around the
call — that the chart reaches storage under the right key, that its caption
reaches the artifact, and that the artifact then produces a retrievable chunk
pointing at the chart's own rectangle — not the model's ability to read a chart,
which is a property of the provider and not of this code.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from konusbitr_worker.ai.tokens import Tokenizer
from konusbitr_worker.chunk import ChunkingOptions, chunk_elements, elements_from_contents
from konusbitr_worker.chunk.elements import figure_elements
from konusbitr_worker.parse import parse_document
from konusbitr_worker.parse.artifact import ParseArtifact
from konusbitr_worker.settings import Settings
from tests.factories import FakeObjectStore, sha256_of

pytestmark = [pytest.mark.asyncio, pytest.mark.slow]

CAPTION = (
    "A bar chart titled Revenue by region, 2024. North America accounts for 54 percent, "
    "Europe for 28 percent and Asia Pacific for 18 percent."
)


class FakeVisionRouter:
    model_name = "fake/vision"

    def __init__(self) -> None:
        self.images: list[bytes] = []

    async def describe(self, **kwargs: Any) -> str:
        self.images.append(kwargs["image"])
        return CAPTION


async def parse(
    fixtures_dir: Path,
    settings: Settings,
    *,
    llm: bool = False,
    router: FakeVisionRouter | None = None,
    monkeypatch: pytest.MonkeyPatch | None = None,
) -> tuple[ParseArtifact, FakeObjectStore]:
    if monkeypatch is not None:
        monkeypatch.setattr(
            "konusbitr_worker.parse.VisionRouter.configured",
            classmethod(lambda cls, _settings: router),
        )
    source = fixtures_dir / "figures-chart.pdf"
    store = FakeObjectStore(source=source)
    artifact = await parse_document(
        store=store,
        settings=settings,
        org_id="org_test",
        document_id="doc_fixture",
        storage_key="orgs/org_test/documents/doc_fixture/original.pdf",
        content_hash=sha256_of(source),
        llm=llm,
    )
    return artifact, store


async def test_the_chart_is_stored_and_the_furniture_is_not(
    settings: Settings, fixtures_dir: Path
) -> None:
    """Extraction runs on every document; it is the *filter* that does the work."""
    artifact, store = await parse(fixtures_dir, settings)

    assert len(artifact.images) == 1
    image = artifact.images[0]
    assert image["storageKey"] == "orgs/org_test/documents/doc_fixture/images/1.png"
    assert store.uploads[image["storageKey"]].startswith(b"\x89PNG")
    assert store.content_types[image["storageKey"]] == "image/png"


async def test_a_figure_is_located_the_same_way_everything_else_is(
    settings: Settings, fixtures_dir: Path
) -> None:
    """One coordinate convention, and a figure is not an exception to it.

    PDFium reports an object's bounds with the origin at the bottom left of the
    unrotated page, which is the opposite of everything stored — so this is the
    assertion that catches a missing flip.
    """
    artifact, _store = await parse(fixtures_dir, settings)
    image = artifact.images[0]

    assert image["page"] == 1
    assert image["bbox"] == pytest.approx([72.0, 268.0, 468.0, 532.0], abs=1.0)


async def test_without_llm_the_figure_is_stored_and_not_described(
    settings: Settings, fixtures_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`llm` is false by default, and it is part of the docId cache key.

    An operator who turns a vision model on does not retroactively send every
    stored document's figures to a provider; a document parsed with captions and
    the same document parsed without them are two cache entries.
    """
    router = FakeVisionRouter()
    artifact, _store = await parse(
        fixtures_dir, settings, llm=False, router=router, monkeypatch=monkeypatch
    )

    assert artifact.images[0]["caption"] is None
    assert router.images == []


async def test_with_llm_the_figure_is_described_through_the_vision_role(
    settings: Settings, fixtures_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    router = FakeVisionRouter()
    artifact, _store = await parse(
        fixtures_dir, settings, llm=True, router=router, monkeypatch=monkeypatch
    )

    assert artifact.images[0]["caption"] == CAPTION
    assert len(router.images) == 1
    assert router.images[0].startswith(b"\x89PNG")


async def test_a_described_figure_becomes_a_retrievable_chunk(
    settings: Settings, fixtures_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The Phase 08 bridge, and the point of the whole feature.

    Ask "which region grew fastest in Q3?" of a document whose only answer is a
    bar chart and the passage that has to come back is this one — carrying the
    chart's own page and rectangle, so that following the citation puts the
    reader in front of the picture.
    """
    router = FakeVisionRouter()
    artifact, _store = await parse(
        fixtures_dir, settings, llm=True, router=router, monkeypatch=monkeypatch
    )
    contents = artifact.to_json(include_markdown=False)

    chunks = chunk_elements(
        elements_from_contents(contents),
        figures=figure_elements(contents),
        tokenizer=Tokenizer(None),
        options=ChunkingOptions(),
    )

    figures = [chunk for chunk in chunks if chunk.kind == "figure"]
    assert len(figures) == 1
    assert "North America" in figures[0].text
    assert figures[0].pages[0]["page"] == 1
    assert figures[0].pages[0]["bbox"] == pytest.approx([72.0, 268.0, 468.0, 532.0], abs=1.0)


async def test_a_reindex_recreates_the_figure_chunk_from_the_cached_parse(
    settings: Settings, fixtures_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No model call and no re-extraction: the captions are in the artifact.

    That is what makes `reindex` cost embeddings rather than a second pass over
    every PDF, and it has to stay true now that an artifact carries figures.
    """
    router = FakeVisionRouter()
    artifact, _store = await parse(
        fixtures_dir, settings, llm=True, router=router, monkeypatch=monkeypatch
    )

    import json

    round_tripped = json.loads(json.dumps(artifact.to_json(include_markdown=False)))
    figures = figure_elements(round_tripped)

    assert [figure.id for figure in figures] == ["img_001"]
    assert figures[0].text.startswith("[Figure: ")
