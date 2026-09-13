"""The document summary that two-stage corpus retrieval searches first."""

from __future__ import annotations

import pytest

from konusbitr_worker.pipeline import (
    SUMMARY_EXCERPT_HEAD,
    SUMMARY_EXCERPT_TAIL,
    _lead_extract,
    _summarization_excerpt,
    _summary_text,
)
from konusbitr_worker.prompts import PromptNotFoundError, load_prompt
from konusbitr_worker.settings import Settings


def test_the_summarize_prompt_is_generated_into_the_worker_package() -> None:
    # The worker image ships only `services/worker/`, so `pnpm codegen` copies
    # the prompts in. A missing file here means codegen was not run.
    prompt = load_prompt("chat.summarize.v1")
    assert "abstract" in prompt.lower()
    # Both spellings resolve, so a caller need not remember the suffix.
    assert load_prompt("chat.summarize.v1.md") == prompt


def test_an_unknown_prompt_names_where_prompts_come_from() -> None:
    with pytest.raises(PromptNotFoundError) as caught:
        load_prompt("chat.nothing.v1")
    assert "packages/ai/prompts" in str(caught.value)


def test_the_lead_extract_skips_headings() -> None:
    # A run of headings is a table of contents, which is the least
    # distinguishing text in a document.
    markdown = "# Title\n\n## Contents\n\nThe tenant shall pay rent monthly.\n"
    assert _lead_extract(markdown) == "The tenant shall pay rent monthly."


def test_the_lead_extract_is_bounded() -> None:
    assert len(_lead_extract(" ".join(["word"] * 500)).split()) == 200


def test_a_short_document_is_summarized_whole() -> None:
    markdown = "short enough to send in full"
    assert _summarization_excerpt(markdown) == markdown


def test_a_long_document_is_summarized_from_both_ends() -> None:
    # A 500-page document does not fit a context window, and an abstract needs
    # the closing as well as the opening.
    markdown = f"{'A' * SUMMARY_EXCERPT_HEAD}{'B' * 50_000}{'Z' * SUMMARY_EXCERPT_TAIL}"
    excerpt = _summarization_excerpt(markdown)

    assert excerpt.startswith("A" * 100)
    assert excerpt.endswith("Z" * 100)
    assert "[…]" in excerpt
    assert len(excerpt) < len(markdown)


@pytest.mark.asyncio
async def test_falls_back_to_an_extract_when_no_chat_model_is_configured(
    settings: Settings,
) -> None:
    # The default `.env` configures no chat model. That is a reduced capability,
    # not a failed job: the summary is extractive and `reindex` regenerates it
    # once a model is named.
    summary = await _summary_text(
        "# Heading\n\nThe quarterly report covers three segments.\n",
        settings=settings,
        document_id="doc_test",
    )
    assert summary == "The quarterly report covers three segments."
