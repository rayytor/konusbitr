"""Asking the vision role what a figure shows, so the index can answer for it.

:mod:`konusbitr_worker.parse.images` gets the pixels out of the document. This
turns them into a sentence, which is the part that makes them searchable: a bar
chart contains the answer to "which region grew fastest in Q3?" and contributes
nothing whatsoever to a text index until somebody writes down what it says.

Four rules govern when this runs, and each of them is a promise being kept:

**Only when the upload asked for it.** `settings.llm` is false by default, and
it is part of the docId cache key — so a document parsed without captions and a
document parsed with them are two different parse results rather than one that
silently changed. An operator who turns a vision model on does not retroactively
send every stored document's figures to a provider.

**Only when a vision role is configured.** No model is the default state of
`docker compose up`, and it is a supported one: figures are still extracted,
stored and located, and they simply have no caption. The alternative — failing
the job — would make an optional capability a hard dependency.

**A caption that cannot be produced is not a failed job.** A provider outage,
a rate limit, a model that refuses one image: the figure keeps its `null`
caption and the parse finishes. The document is worth having without its chart
descriptions; it is not worth losing over them.

**The caption is the model's, and the figure is untrusted input.** Text drawn
inside an image is document content in exactly the way text on a page is, so the
prompt says so explicitly and the answer is stored as data. Nothing here ever
executes, dispatches on, or logs what came back.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence

from konusbitr_worker.ai.vision import VisionRouter
from konusbitr_worker.log import get_logger
from konusbitr_worker.parse.images import ExtractedImage, ImageCandidate
from konusbitr_worker.prompts import load_prompt

__all__ = ["CAPTION_MAX_TOKENS", "CAPTION_PROMPT", "NO_CONTENT_SENTINEL", "caption_images"]

logger = get_logger("konusbitr.worker.parse.captions")

#: The versioned prompt. Never an inline literal — a change in an eval score has
#: to be attributable to a change in a prompt, which means the prompt needs a
#: version and a file. See `packages/ai/prompts/`.
CAPTION_PROMPT = "caption.figure.v1"

#: What the prompt tells the model to answer for a figure with nothing in it.
#: Matched exactly, and the match is why the prompt asks for a fixed string
#: rather than for "say so": a free-form refusal would be indexed as if it were
#: a description, and "I cannot see any meaningful content in this image" is a
#: passage that retrieves for questions about images.
NO_CONTENT_SENTINEL = "NO FIGURE CONTENT"

#: Two or three sentences, with room for a long axis label.
CAPTION_MAX_TOKENS = 220

#: What the model is asked, alongside the image. The instructions are in the
#: system prompt; this is the turn that carries the picture.
_USER_TURN = "Describe this figure for a document search index."

#: How many figures are described at once.
#:
#: Small. These are whole images on the wire and a slide deck can carry
#: hundreds; a worker that fires all of them concurrently rate-limits itself out
#: of the provider and holds every bitmap in memory while it waits.
_CONCURRENCY = 4


async def caption_images(
    images: Sequence[tuple[ExtractedImage, ImageCandidate]],
    *,
    router: VisionRouter | None,
) -> int:
    """Fill in each figure's caption in place. Returns how many were captioned.

    Takes the stored record and the bytes side by side rather than re-reading
    the object out of storage: the candidate is still in hand from the
    extraction pass, and a round trip per figure to fetch back what was just
    uploaded would double the storage traffic of a figure-heavy document.
    """
    if router is None or not images:
        return 0

    system = load_prompt(CAPTION_PROMPT)
    limiter = asyncio.Semaphore(_CONCURRENCY)
    captioned = 0

    async def describe(image: ExtractedImage, candidate: ImageCandidate) -> None:
        nonlocal captioned
        async with limiter:
            try:
                answer = await router.describe(
                    system=system,
                    prompt=_USER_TURN,
                    image=candidate.data,
                    max_tokens=CAPTION_MAX_TOKENS,
                )
            except Exception:
                # Named by id and page only. The exception text can carry the
                # provider's echo of what it was sent, and document content
                # never reaches telemetry.
                logger.warning(
                    "could not caption a figure",
                    extra={"image": image.id, "page": image.page},
                    exc_info=True,
                )
                return

        caption = _usable(answer)
        if caption is None:
            return
        image.caption = caption
        captioned += 1

    await asyncio.gather(*(describe(image, candidate) for image, candidate in images))

    logger.info(
        "figures captioned",
        extra={"figures": len(images), "captioned": captioned, "model": router.model_name},
    )
    return captioned


def _usable(answer: str) -> str | None:
    """The caption, or `None` when the model said there was nothing to describe.

    Also rejects an answer too short to be two sentences about anything. A
    one-word reply is a model that did not look, and storing it would put a
    chunk in the index whose entire content is the word "Chart".
    """
    text = " ".join((answer or "").split())
    if not text:
        return None
    if NO_CONTENT_SENTINEL.lower() in text.lower():
        return None
    if len(text) < 24:
        return None
    return text
