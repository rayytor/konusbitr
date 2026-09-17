"""The advanced (VLM) tier: Phase 12.3.

Four modules, one job each, in the order a page passes through them:

- :mod:`~konusbitr_worker.parse.vlm.pipeline` composes the tier — render, ask,
  parse, reconcile — and is the only thing the parse pipeline imports.
- :mod:`~konusbitr_worker.parse.vlm.response` turns a model's answer into
  located elements, and is where every way a provider can bend a JSON contract
  is absorbed.
- :mod:`~konusbitr_worker.parse.vlm.reconcile` is the hybrid engine: the
  model's structure, the text layer's characters.
- :mod:`~konusbitr_worker.parse.vlm.cost` mirrors the TypeScript cost
  arithmetic so the ceiling is enforced on both sides of the queue.

`docs/adr/0007-vlm-tier.md` records why the tier is grounded against a text
layer rather than trusted, why the ceiling is a refusal rather than a
truncation, and why the boxes come back on a 0-1000 scale.
"""

from __future__ import annotations

from konusbitr_worker.parse.vlm.cost import VlmCostEstimate, estimate_vlm_cost
from konusbitr_worker.parse.vlm.pipeline import (
    VLM_PARSE_PROMPT,
    VlmOptions,
    VlmPageResult,
    read_pages,
)
from konusbitr_worker.parse.vlm.reconcile import (
    GROUNDING_FLOOR,
    ReconciliationReport,
    reconcile_element,
    reconcile_page,
)
from konusbitr_worker.parse.vlm.response import VlmElement, parse_response

__all__ = [
    "GROUNDING_FLOOR",
    "VLM_PARSE_PROMPT",
    "ReconciliationReport",
    "VlmCostEstimate",
    "VlmElement",
    "VlmOptions",
    "VlmPageResult",
    "estimate_vlm_cost",
    "parse_response",
    "read_pages",
    "reconcile_element",
    "reconcile_page",
]
