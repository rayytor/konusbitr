#!/usr/bin/env bash
# Install both SDKs the way a user would and run their quickstarts.
#
# "The way a user would" is the point. The workspace can import
# `@konusbitr/sdk` from source and `konusbitr` from an editable install, and
# both of those work when the published artifact would not — a missing `files`
# entry, an export map pointing at a path the build does not produce, a wheel
# that left a module out. So each SDK is *packed*, installed from the pack into
# an empty directory with nothing else on its path, and only then run.
#
#   KONUSBITR_API_KEY=kb_live_... ./scripts/sdk-quickstart.sh
#
# KONUSBITR_URL defaults to http://localhost:3000. Set SDK_SOURCE=registry to
# install the published packages from npm and PyPI instead of packing them,
# which is the check to run after a release.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="${FIXTURE:-$ROOT/fixtures/pdf/clean-text-10p.pdf}"
SOURCE="${SDK_SOURCE:-pack}"

if [[ -z "${KONUSBITR_API_KEY:-}" ]]; then
  echo "sdk-quickstart: set KONUSBITR_API_KEY to a key with the parse scope." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ── TypeScript ───────────────────────────────────────────────────────────────

echo "sdk-quickstart: @konusbitr/sdk ($SOURCE)"
mkdir -p "$work/ts"

if [[ "$SOURCE" == "registry" ]]; then
  ts_spec="@konusbitr/sdk"
else
  pnpm --dir "$ROOT" --filter @konusbitr/sdk build > /dev/null
  (cd "$ROOT/packages/sdk" && pnpm pack --pack-destination "$work" > /dev/null)
  ts_spec="$(ls "$work"/konusbitr-sdk-*.tgz)"
fi

(
  cd "$work/ts"
  npm init -y > /dev/null
  npm install --no-audit --no-fund --silent "$ts_spec"
  cp "$ROOT/packages/sdk/examples/quickstart.mjs" .
  node quickstart.mjs "$FIXTURE"
)

# ── Python ───────────────────────────────────────────────────────────────────

echo "sdk-quickstart: konusbitr ($SOURCE)"

if [[ "$SOURCE" == "registry" ]]; then
  py_spec="konusbitr"
else
  uv build --quiet --wheel --project "$ROOT/sdks/python" --out-dir "$work/dist"
  py_spec="$(ls "$work"/dist/konusbitr-*.whl)"
fi

uv venv --quiet --python 3.12 "$work/py"
uv pip install --quiet --python "$work/py/bin/python" "$py_spec"
# Run from the temporary directory, so `import konusbitr` can only find the
# installed package and never the repository's own source tree.
(cd "$work" && "$work/py/bin/python" "$ROOT/sdks/python/examples/quickstart.py" "$FIXTURE")

echo "sdk-quickstart: both quickstarts ran"
