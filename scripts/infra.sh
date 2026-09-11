#!/usr/bin/env bash
# Konusbitr local infrastructure.
#
#   ./scripts/infra.sh up       backing services only (postgres, redis, minio)
#   ./scripts/infra.sh stack    the whole thing, including web and worker
#   ./scripts/infra.sh down     stop everything, keep the data
#   ./scripts/infra.sh reset    stop everything and delete the volumes
#   ./scripts/infra.sh logs     follow the logs [service...]
#   ./scripts/infra.sh ps       what is running, and whether it is healthy
#   ./scripts/infra.sh psql     a psql shell on the app database
#   ./scripts/infra.sh redis    a redis-cli shell
#   ./scripts/infra.sh wait     block until every started container is healthy
#
# `up` is what `pnpm dev:infra` calls: it brings up the backing services and
# nothing else, so the web app and the worker can run natively with hot reload
# while still talking to real Postgres, Redis and MinIO.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Services a native `pnpm dev` still needs running in containers.
BACKING=(postgres redis minio)

# How long `wait` gives the slowest container. Postgres initdb plus MinIO on a
# cold volume is the worst case.
TIMEOUT_SECONDS="${INFRA_TIMEOUT_SECONDS:-240}"

die() {
  echo "infra: $*" >&2
  exit 1
}

require_docker() {
  command -v docker > /dev/null 2>&1 || die "docker is not installed or not on PATH"
  docker compose version > /dev/null 2>&1 || die "this needs Docker Compose v2 ('docker compose', not 'docker-compose')"
}

require_env() {
  if [[ ! -f .env ]]; then
    echo "infra: no .env found; copying .env.example" >&2
    cp .env.example .env
  fi
}

# Reads container state through `docker inspect` rather than `docker compose ps
# --format`, because inspect's Go templates are stable across Compose versions
# and need no jq on the host.
wait_for_healthy() {
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  local pending

  while :; do
    pending=""
    while read -r name status health; do
      case "$health" in
        healthy) continue ;;
        none)
          # No healthcheck: running is as good as it gets, and a one-shot that
          # exited 0 has done its job.
          [[ "$status" == "running" ]] && continue
          [[ "$status" == "exited" ]] && continue
          ;;
        unhealthy) die "$name is unhealthy — see: docker compose logs $name" ;;
      esac
      pending+=" $name"
    done < <(
      docker compose ps -qa | while read -r id; do
        [[ -n "$id" ]] || continue
        docker inspect -f \
          '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
          "$id"
      done
    )

    [[ -z "$pending" ]] && break

    if ((SECONDS > deadline)); then
      die "timed out after ${TIMEOUT_SECONDS}s waiting for:$pending"
    fi
    sleep 2
  done

  # A one-shot that failed leaves the stack subtly broken — no bucket, say — so
  # check exit codes rather than only liveness.
  while read -r id; do
    [[ -n "$id" ]] || continue
    read -r name status code < <(
      docker inspect -f '{{.Name}} {{.State.Status}} {{.State.ExitCode}}' "$id"
    )
    if [[ "$status" == "exited" && "$code" != "0" ]]; then
      die "$name exited with code $code — see: docker compose logs ${name#/konusbitr-}"
    fi
  done < <(docker compose ps -qa)
}

cmd_up() {
  require_docker
  require_env
  docker compose up -d "${BACKING[@]}"
  wait_for_healthy
  # Bucket and access key. Idempotent, and run as a foreground one-shot so a
  # failure is visible rather than buried in `docker compose logs`.
  docker compose run --rm --no-deps minio-init
  echo "infra: postgres, redis and minio are up"
}

cmd_stack() {
  require_docker
  require_env
  docker compose up -d --build
  wait_for_healthy
  echo "infra: the full stack is up on ${APP_URL:-http://localhost:3000}"
}

cmd_down() {
  require_docker
  docker compose --profile local-llm down --remove-orphans
}

cmd_reset() {
  require_docker
  echo "infra: this deletes the Postgres, Redis, MinIO and Ollama volumes." >&2
  docker compose --profile local-llm down --remove-orphans --volumes
  echo "infra: volumes removed; the next 'up' starts from empty"
}

cmd_psql() {
  require_docker
  if [[ -f .env ]]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
  fi
  docker compose exec postgres psql \
    -U "${POSTGRES_USER:-konusbitr}" -d "${POSTGRES_DB:-konusbitr}" "$@"
}

main() {
  local command="${1:-up}"
  shift || true

  case "$command" in
    up) cmd_up ;;
    stack) cmd_stack ;;
    down) cmd_down ;;
    reset) cmd_reset ;;
    logs) require_docker && docker compose logs -f "$@" ;;
    ps) require_docker && docker compose ps -a ;;
    psql) cmd_psql "$@" ;;
    redis) require_docker && docker compose exec redis redis-cli "$@" ;;
    wait) require_docker && wait_for_healthy && echo "infra: everything is healthy" ;;
    # The header comment above is the help text, so the two cannot drift.
    -h | --help | help)
      awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
      ;;
    *) die "unknown command '$command' (try: --help)" ;;
  esac
}

main "$@"
