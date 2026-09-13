#!/usr/bin/env bash
# `pnpm codegen` — regenerate the Python half of the cross-runtime contract.
#
# The Zod schemas in `packages/shared` are the source of truth for every payload
# that crosses the TypeScript ↔ Python seam. This turns them into
# `services/worker/src/konusbitr_worker/contracts.py`, which the worker
# validates against and which nobody may hand-edit.
#
# Contract drift is the main failure mode of a two-language architecture, so
# this has one property that matters more than anything else about it: on a
# clean tree it is a **no-op**. CI runs it and then `git diff --exit-code`, and
# a change to the Zod that was not regenerated cannot be merged.
#
# Needs Node (for the schemas) and uv (for datamodel-code-generator).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORKER="services/worker"
OUTPUT="$WORKER/src/konusbitr_worker/contracts.py"
PROMPTS_SOURCE="packages/ai/prompts"
PROMPTS_OUTPUT="$WORKER/src/konusbitr_worker/prompts"

die() {
  echo "codegen: $*" >&2
  exit 1
}

command -v uv > /dev/null 2>&1 \
  || die "uv is not installed; see https://docs.astral.sh/uv/ (the worker's toolchain is uv, not pip)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "codegen: emitting JSON Schema from the Zod source"
pnpm --filter @konusbitr/shared exec tsx scripts/emit-contract.ts "$WORK"

echo "codegen: generating pydantic models"
# `--disable-timestamp` is not cosmetic: a generation timestamp in the header
# would make every run a diff, which is exactly the signal this file exists to
# carry.
uv run --project "$WORKER" --quiet datamodel-codegen \
  --input "$WORK/contract.schema.json" \
  --input-file-type jsonschema \
  --output "$WORK/models.py" \
  --output-model-type pydantic_v2.BaseModel \
  --target-python-version 3.12 \
  --disable-timestamp \
  --use-standard-collections \
  --use-union-operator \
  --use-double-quotes \
  --field-constraints \
  --use-annotated \
  --use-schema-description \
  --use-field-description \
  --collapse-root-models \
  --use-root-model-type-alias \
  --skip-root-model \
  --enum-field-as-literal none \
  --custom-file-header-path /dev/null

{
  cat << 'HEADER'
"""The TypeScript ↔ Python contract. **Generated — do not edit.**

Every payload that crosses the seam between the two runtimes is defined once, in
Zod, in ``packages/shared``. This module is produced from those definitions by
``pnpm codegen``; CI regenerates it and fails on any diff, so editing it here
cannot survive review and editing the Zod without regenerating cannot merge.

To change a payload: edit ``packages/shared/src/job.ts`` (or ``queue.ts`` for
the Redis key names), run ``pnpm codegen``, and commit both halves together.
"""
HEADER
  # The generator writes its own `from __future__` line; keeping ours out of the
  # way avoids a duplicate import that ruff would then have to strip.
  cat "$WORK/models.py"
  cat "$WORK/constants.py"
} > "$OUTPUT"

uv run --project "$WORKER" --quiet ruff format --quiet "$OUTPUT"
uv run --project "$WORKER" --quiet ruff check --quiet --fix-only "$OUTPUT"

echo "codegen: wrote $OUTPUT"

# ── Prompts ──────────────────────────────────────────────────────────────────
#
# Prompts live in `packages/ai/prompts/` as versioned files, and both runtimes
# send them. The worker image ships only `services/worker/`, so it needs its own
# copy — and a copy maintained by hand is a second source of truth that drifts,
# which is the one thing the prompt-versioning rule exists to prevent. So the
# copy is generated here and CI's `git diff --exit-code` holds it honest, the
# same way it holds `contracts.py` honest.
echo "codegen: syncing prompts into the worker package"
rm -rf "$PROMPTS_OUTPUT"
mkdir -p "$PROMPTS_OUTPUT"
cat > "$PROMPTS_OUTPUT/README.md" << 'PROMPTS_README'
# Generated — do not edit

Copied from `packages/ai/prompts/` by `pnpm codegen`, because the worker image
ships only `services/worker/` and still has to send the same prompts the product
surface does. Edit the originals and regenerate; CI fails on drift.
PROMPTS_README
for prompt in "$PROMPTS_SOURCE"/*.md; do
  name="$(basename "$prompt")"
  [ "$name" = "README.md" ] && continue
  cp "$prompt" "$PROMPTS_OUTPUT/$name"
done
echo "codegen: wrote $PROMPTS_OUTPUT"
