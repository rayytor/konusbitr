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

# The vision model is optional, unlike the other two. It is several gigabytes
# and it is only needed by two things — figure captions, and Phase 12.3's
# advanced parser — so a stack that wants offline chat and retrieval and nothing
# else should not be made to wait for it. Unset simply skips it.
models="${OLLAMA_CHAT_MODEL} ${OLLAMA_EMBEDDING_MODEL} ${OLLAMA_VISION_MODEL:-}"

for model in ${models}; do
  echo "ollama-init: pulling ${model}"
  ollama pull "${model}"
done

echo "ollama-init: done"
