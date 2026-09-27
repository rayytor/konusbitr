# The Python SDK's three commands. `uv` is the toolchain, as it is for the worker.

.PHONY: generate generate-check test lint build

## Regenerate the types and the operation table from docs/openapi.json.
generate:
	uv run python scripts/generate.py
	uv run ruff format src/konusbitr/_generated.py

## Regenerate and fail on any diff. CI runs this: the SDK cannot drift from the API.
generate-check: generate
	git diff --exit-code -- src/konusbitr/_generated.py

test:
	uv run pytest -q

lint:
	uv run ruff check .
	uv run ruff format --check .

build:
	uv build
