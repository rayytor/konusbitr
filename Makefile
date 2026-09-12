# Konusbitr — a thin wrapper for people who reach for `make` before `pnpm`.
#
# Every target here delegates to scripts/infra.sh or to a pnpm script; there is
# no build logic in this file, so `make` and `pnpm` can never disagree about
# what a command does.

.DEFAULT_GOAL := help
.PHONY: help up migrate stack down reset logs ps psql redis dev dev-infra install check

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install TypeScript and Python dependencies
	pnpm install
	cd services/worker && uv sync

up: ## Start the backing services (postgres, redis, minio)
	./scripts/infra.sh up

migrate: ## Apply pending database migrations
	./scripts/infra.sh migrate

stack: ## Start everything in containers, including web and worker
	./scripts/infra.sh stack

down: ## Stop every container, keeping the data
	./scripts/infra.sh down

reset: ## Stop every container and delete the volumes
	./scripts/infra.sh reset

logs: ## Follow the logs
	./scripts/infra.sh logs

ps: ## Show container status and health
	./scripts/infra.sh ps

psql: ## Open a psql shell on the app database
	./scripts/infra.sh psql

redis: ## Open a redis-cli shell
	./scripts/infra.sh redis

dev-infra: up ## Alias for `up`

dev: ## Backing services in Docker, web and worker native
	pnpm dev

check: ## The standard gate: lint, typecheck, test, build, plus the Python side
	pnpm turbo run lint typecheck test build
	cd services/worker && uv run ruff check . && uv run ruff format --check . && uv run pytest
