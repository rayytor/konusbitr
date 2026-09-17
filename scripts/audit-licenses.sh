#!/usr/bin/env bash
# `pnpm audit:licenses` — prove the default build is cleanly Apache-2.0 compatible.
#
# Konusbitr's licensing promise is about what `docker compose up` installs, and
# the list that matters is the *transitive* one: a restrictively-licensed
# package almost always arrives as somebody else's dependency rather than as a
# line anybody wrote. So both halves of this audit run over installed trees, not
# over manifests.
#
# The Python half is `services/worker/tests/test_licensing.py`, run here as a
# test so there is exactly one implementation of the rule — a CI script with its
# own copy of the allowlist is a second source of truth that drifts from the one
# developers actually run.
#
# The Node half walks the pnpm dependency tree. It is a sweep rather than a
# test because the failure modes differ: the Node ecosystem is overwhelmingly
# MIT, the worker's is where the genuinely tempting copyleft libraries live, and
# the interesting question on this side is only "did something change".
#
# See `docs/licensing.md` for what is in the default build, what is quarantined
# behind the `advanced` profile, and what changes if you cross that line.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

#: Licence families that must never appear in the default build.
#:
#: `lgpl` is deliberately absent from the pattern and handled by the exclusion
#: below: it is a different bargain from the GPL, it is not in this tree today,
#: and a naive substring match would flag it as one.
REFUSED='AGPL|(^|[^L])GPL|SSPL|Commons Clause|[Nn]on-?[Cc]ommercial|CC-BY-NC'

fail=0

echo "audit:licenses — the Python worker (installed environment)"
echo

if command -v uv > /dev/null 2>&1; then
  # Run from the worker directory: `uv run --project` chooses the environment
  # but leaves the working directory alone, and pytest's paths are relative to
  # where it was invoked. The subshell keeps that `cd` from leaking.
  if (cd services/worker && uv run --quiet pytest tests/test_licensing.py -q); then
    echo "  ok — no AGPL, GPL or non-commercial package in the worker environment"
  else
    echo "  FAILED — see the assertion above"
    fail=1
  fi
else
  echo "  skipped — uv is not installed (see https://docs.astral.sh/uv/)"
  echo "  This is the half that matters most; CI never skips it."
fi

echo
echo "audit:licenses — the Node workspace (installed tree)"
echo

# `--long` is what carries the licence field; `--json` then lets this be a grep
# rather than a parser. Dev dependencies are included deliberately: a GPL
# build-time tool does not infect the output, but it is still something an
# operator auditing this repository will find and ask about, and it should not
# arrive as a surprise.
offenders="$(
  pnpm licenses list --json --prod 2> /dev/null \
    | grep -E "\"(license|licenses)\":" \
    | grep -Ei "$REFUSED" \
    || true
)"

if [ -n "$offenders" ]; then
  echo "  restrictively-licensed packages in the Node tree:"
  echo "$offenders" | sed 's/^/    /'
  fail=1
else
  echo "  ok — no AGPL, GPL or non-commercial package in the production tree"
fi

echo

if [ "$fail" -ne 0 ]; then
  cat << 'EOF'
audit:licenses FAILED.

AGPL, GPL and non-commercially-licensed dependencies belong behind the
`advanced` Compose profile — pinned in docker/advanced-requirements.txt,
installed by the `worker-advanced` Docker stage alone, reached through
konusbitr_worker.parse.advanced, and never in the image that `docker compose up`
builds. They must not appear in services/worker/pyproject.toml even as an extra:
uv resolves extras together with the base dependencies, so an extra constrains
the default build.

docs/licensing.md says what the boundary is and how to add a dependency on
either side of it.
EOF
  exit 1
fi

echo "audit:licenses passed. The default build stays cleanly Apache-2.0 compatible."
