#!/usr/bin/env bash
# Run a k6 script from `load/k6`, with k6 itself or with its container.
#
# The container is given the host's network so `localhost:3000` means the same
# thing inside it as it does to the person who typed the command, and the
# repository read-only, because the scripts read fixtures and write nothing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="${1:?usage: scripts/k6.sh <script under load/k6> [k6 run args...]}"
shift

if [[ -z "${KONUSBITR_API_KEY:-}" ]]; then
  echo "k6: set KONUSBITR_API_KEY to a key from Settings → API keys." >&2
  exit 1
fi

if command -v k6 > /dev/null 2>&1; then
  cd "$ROOT"
  exec k6 run "$@" "load/k6/$script"
fi

exec docker run --rm --network host \
  -e KONUSBITR_API_KEY \
  -e KONUSBITR_URL \
  -e DOC_ID \
  -v "$ROOT:/repo:ro" \
  -w /repo \
  grafana/k6:2.3.0 run "$@" "load/k6/$script"
