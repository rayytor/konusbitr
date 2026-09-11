#!/bin/sh
# Pre-pull the models the `local-llm` profile promises.
#
# Konusbitr's fully-offline mode is a headline claim, and a stack that comes up
# with no models is not offline-capable — it is just broken later. Pulling here,
# as a one-shot that the profile always runs, means the first query is fast and
# OFFLINE_MODE=true is honest. Ollama skips models it already has, so this is
# cheap on every boot after the first.

set -eu

: "${OLLAMA_HOST:?OLLAMA_HOST is required}"
: "${OLLAMA_CHAT_MODEL:?OLLAMA_CHAT_MODEL is required}"
: "${OLLAMA_EMBEDDING_MODEL:?OLLAMA_EMBEDDING_MODEL is required}"

export OLLAMA_HOST

for model in "${OLLAMA_CHAT_MODEL}" "${OLLAMA_EMBEDDING_MODEL}"; do
  echo "ollama-init: pulling ${model}"
  ollama pull "${model}"
done

echo "ollama-init: done"
