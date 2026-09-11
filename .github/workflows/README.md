# Workflows

- `ci.yml` — the merge gate. Two independent jobs, one per runtime, so a change
  to only one half does not wait on the other. Both must be green.

Later phases add to this directory rather than to `ci.yml`: a licence audit that
asserts the default build stays Apache-2.0 clean (Phase 15), the Zod → pydantic
contract-drift check (Phase 06), and the evaluation gates for retrieval recall
and answer faithfulness (Phase 15).
