"""The `split` job: the cut, the derived parse, and what a re-delivery does.

The decision about *where* to cut is TypeScript's and is tested there
(`apps/web/test/v2/ranges.test.ts`). What is tested here is the half only this
runtime can do, against a real PDF from the fixture corpus: that the outputs are
real PDFs with the right pages in them, that an output's inherited parse is
numbered from one, and that the same job delivered twice produces the same
documents rather than a second set.
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from typing import Any

import pytest
from pypdf import PdfReader

from konusbitr_worker.contracts import JobErrorCode, SplitRange
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.parse.artifact import ParseArtifact
from konusbitr_worker.parse.split import derive_artifact, slice_ranges
from konusbitr_worker.progress import ProgressReporter
from konusbitr_worker.settings import Settings
from konusbitr_worker.split_job import run_split
from tests.factories import (
    FakeDatabase,
    FakeObjectStore,
    FakeQueue,
    make_document,
    make_payload,
    sha256_of,
)

SETTINGS_HASH = "b" * 64


def _range(start: int, end: int, name: str) -> SplitRange:
    return SplitRange(start=start, end=end, name=name)


def _page_text(content: bytes, index: int) -> str:
    return PdfReader(BytesIO(content)).pages[index].extract_text()


class SplitDatabase(FakeDatabase):
    """The double, plus the one write only a split makes.

    Mirrors the real statement's `ON CONFLICT (org_id, content_hash,
    settings_hash) DO NOTHING`: a second insert of the same bytes returns the
    row that is already there, which is the property the re-delivery test is
    about.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.split_documents: list[dict[str, Any]] = []

    async def create_split_document(self, **kwargs: Any) -> str | None:
        for row in self.split_documents:
            if (
                row["org_id"] == kwargs["org_id"]
                and row["content_hash"] == kwargs["content_hash"]
                and row["settings_hash"] == kwargs["settings_hash"]
            ):
                return str(row["document_id"])
        self.split_documents.append(kwargs)
        return str(kwargs["document_id"])


# ── the cut ────────────────────────────────────────────────────────────────────


def test_each_range_becomes_a_pdf_holding_exactly_its_pages(fixtures_dir: Path) -> None:
    source = fixtures_dir / "clean-text-10p.pdf"
    parent = PdfReader(str(source))

    outputs = slice_ranges(source, [_range(1, 3, "intro.pdf"), _range(7, 7, "seven.pdf")])

    assert [(o.name, o.pages, o.page_count) for o in outputs] == [
        ("intro.pdf", [1, 2, 3], 3),
        ("seven.pdf", [7], 1),
    ]
    assert len(PdfReader(BytesIO(outputs[0].content)).pages) == 3
    # The page that came out is the page that was asked for, not merely a page.
    assert _page_text(outputs[1].content, 0) == parent.pages[6].extract_text()
    assert _page_text(outputs[0].content, 2) == parent.pages[2].extract_text()


def test_the_same_cut_twice_is_the_same_bytes(fixtures_dir: Path) -> None:
    """The content hash is the output's identity, so the cut must be deterministic.

    If pypdf stamped a time or a random `/ID` into what it writes, a re-delivered
    job would hash differently, miss the `ON CONFLICT`, and create every output
    a second time.
    """
    source = fixtures_dir / "clean-text-10p.pdf"
    first = slice_ranges(source, [_range(2, 5, "a.pdf")])
    second = slice_ranges(source, [_range(2, 5, "a.pdf")])

    assert first[0].content_hash == second[0].content_hash


def test_a_range_past_the_end_is_clamped_and_one_wholly_past_it_is_skipped(
    fixtures_dir: Path,
) -> None:
    source = fixtures_dir / "clean-text-10p.pdf"

    outputs = slice_ranges(source, [_range(9, 40, "tail.pdf"), _range(20, 30, "nothing.pdf")])

    assert [(o.name, o.pages) for o in outputs] == [("tail.pdf", [9, 10])]


def test_no_usable_range_at_all_is_a_terminal_failure(fixtures_dir: Path) -> None:
    with pytest.raises(JobFailure) as raised:
        slice_ranges(fixtures_dir / "clean-text-10p.pdf", [_range(20, 30, "nothing.pdf")])

    assert raised.value.code is JobErrorCode.invalid_payload


def test_an_encrypted_parent_is_refused(fixtures_dir: Path) -> None:
    with pytest.raises(JobFailure) as raised:
        slice_ranges(fixtures_dir / "encrypted.pdf", [_range(1, 1, "one.pdf")])

    assert raised.value.code is JobErrorCode.encrypted_document


def test_a_parent_that_is_not_a_pdf_is_refused(fixtures_dir: Path) -> None:
    with pytest.raises(JobFailure) as raised:
        slice_ranges(fixtures_dir / "malformed.pdf", [_range(1, 1, "one.pdf")])

    assert raised.value.code is JobErrorCode.corrupt_document


# ── the derived parse ──────────────────────────────────────────────────────────


def test_a_derived_artifact_is_numbered_from_one(artifact: ParseArtifact) -> None:
    parent = artifact.to_json(include_markdown=False)
    contents, markdown = derive_artifact(parent, artifact.markdown, [2])

    assert contents["pageCount"] == 1
    assert [element["page"] for element in contents["contents"]] == [1]
    assert [page["pageNo"] for page in contents["pages"]] == [1]
    assert markdown == "Costs were flat against a rising headcount."
    # The box is untouched: a page moved to a new document is the same page.
    assert contents["contents"][0]["bbox"] == parent["contents"][2]["bbox"]


def test_a_derived_artifact_points_at_nothing_under_the_parents_prefix(
    artifact: ParseArtifact,
) -> None:
    parent = artifact.to_json(include_markdown=False)
    contents, _ = derive_artifact(parent, artifact.markdown, [1, 2])

    assert all(page["thumbnailKey"] is None for page in contents["pages"])
    assert contents["images"] == []


# ── the job ────────────────────────────────────────────────────────────────────


def _parent(fixtures_dir: Path, artifact: ParseArtifact) -> tuple[Path, SplitDatabase, Any]:
    source = fixtures_dir / "clean-text-10p.pdf"
    content_hash = sha256_of(source)
    database = SplitDatabase(
        make_document(content_hash=content_hash, settings_hash=SETTINGS_HASH, status="ready")
    )
    database.parse_results.append(
        {
            "content_hash": content_hash,
            "settings_hash": SETTINGS_HASH,
            "markdown": artifact.markdown,
            "contents": artifact.to_json(include_markdown=False),
            "page_count": artifact.page_count,
            "checkpoint": None,
        }
    )
    payload = make_payload(
        type="split",
        contentHash=content_hash,
        split={
            "ranges": [
                {"start": 1, "end": 1, "name": "title.pdf"},
                {"start": 2, "end": 2, "name": "costs.pdf"},
            ],
            "inheritParse": True,
        },
    )
    return source, database, payload


@pytest.mark.asyncio
async def test_a_split_writes_real_documents_that_are_ready_and_indexed(
    settings: Settings, queue: FakeQueue, fixtures_dir: Path, artifact: ParseArtifact
) -> None:
    source, database, payload = _parent(fixtures_dir, artifact)
    store = FakeObjectStore(source)

    outcome = await run_split(
        payload,
        database=database,  # type: ignore[arg-type]
        progress=ProgressReporter(payload=payload, queue=queue, database=database),  # type: ignore[arg-type]
        settings=settings,
        store=store,  # type: ignore[arg-type]
    )

    assert [(d["name"], d["pages"]) for d in outcome.documents] == [
        ("title.pdf", [1]),
        ("costs.pdf", [2]),
    ]

    for document, row in zip(outcome.documents, database.split_documents, strict=True):
        assert row["status"] == "ready"
        assert row["page_count"] == 1
        # Keys are built from generated ids. The range name is document text
        # and never reaches a storage path.
        assert row["storage_key"] == f"orgs/org_test/documents/{document['docId']}/original.pdf"
        assert store.uploads[row["storage_key"]].startswith(b"%PDF")
        # `ready` with nothing indexed is the state the invariant forbids.
        assert await database.chunk_count(document["docId"]) > 0

    # Each output has a finished parse of its own, so it is a docId cache entry.
    derived = [row for row in database.parse_results if row.get("document_id")]
    assert len(derived) == 2
    assert all(row["checkpoint"] is None and row["page_count"] == 1 for row in derived)


@pytest.mark.asyncio
async def test_a_redelivered_split_produces_the_same_documents(
    settings: Settings, queue: FakeQueue, fixtures_dir: Path, artifact: ParseArtifact
) -> None:
    source, database, payload = _parent(fixtures_dir, artifact)
    store = FakeObjectStore(source)

    async def deliver() -> list[str]:
        outcome = await run_split(
            payload,
            database=database,  # type: ignore[arg-type]
            progress=ProgressReporter(payload=payload, queue=queue, database=database),  # type: ignore[arg-type]
            settings=settings,
            store=store,  # type: ignore[arg-type]
        )
        return [document["docId"] for document in outcome.documents]

    first = await deliver()
    chunks_after_first = len(database.chunks)
    second = await deliver()

    assert second == first
    assert len(database.split_documents) == 2
    assert len(database.chunks) == chunks_after_first


@pytest.mark.asyncio
async def test_a_split_of_a_changed_document_is_terminal(
    settings: Settings, queue: FakeQueue, fixtures_dir: Path, artifact: ParseArtifact
) -> None:
    source, database, payload = _parent(fixtures_dir, artifact)
    stale = payload.model_copy(update={"contentHash": "c" * 64})

    with pytest.raises(JobFailure) as raised:
        await run_split(
            stale,
            database=database,  # type: ignore[arg-type]
            progress=ProgressReporter(payload=stale, queue=queue, database=database),  # type: ignore[arg-type]
            settings=settings,
            store=FakeObjectStore(source),  # type: ignore[arg-type]
        )

    assert raised.value.code is JobErrorCode.content_hash_mismatch
