#!/usr/bin/env bash
# `pnpm dev` — backing services in containers, application code native.
#
# The web app and the worker run on the host so that hot reload is instant and a
# debugger attaches the way it normally would; only Postgres, Redis and MinIO
# live in Docker. That split is why `.env` uses localhost hostnames and
# `docker-compose.yml` overrides them for its own containers.
#
# Both processes share this terminal. Ctrl-C stops them; the backing services
# keep running, because restarting Postgres on every code change is nobody's
# idea of a fast loop. Stop those with `pnpm infra:down`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

"$ROOT/scripts/infra.sh" up

pids=()

cleanup() {
  trap - INT TERM EXIT
  for pid in "${pids[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2> /dev/null || true
  done
  wait 2> /dev/null || true
}
trap cleanup INT TERM EXIT

echo "dev: starting the web app on ${APP_URL:-http://localhost:3000}"
pnpm --filter @konusbitr/web dev &
pids+=($!)

echo "dev: starting the worker"
(cd services/worker && uv run python -m konusbitr_worker) &
pids+=($!)

# Exit as soon as either side dies, rather than leaving half a stack running and
# looking healthy.
wait -n
echo "dev: a process exited; shutting the other one down" >&2
