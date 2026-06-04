#!/usr/bin/env bash
# Build + run the taffy-web (self-hosted web) image locally for testing.
#
#   ./scripts/dev-docker.sh                 # build (if needed) + run on :8787
#   PORT=9000 ./scripts/dev-docker.sh
#   TAFFY_TOKEN=secret ./scripts/dev-docker.sh
#   REBUILD=1 ./scripts/dev-docker.sh       # force image rebuild
#   NOCACHE=1 ./scripts/dev-docker.sh       # rebuild without cache
#
# Provider keys present in your shell (TAFFY_API_KEY / TAFFY_OPENAI_API_KEY /
# TAFFY_ANTHROPIC_API_KEY / TAFFY_GEMINI_API_KEY) are forwarded into the
# container; the server injects them into LLM requests.
set -euo pipefail

PORT="${PORT:-8787}"
IMG="taffy-web:dev"
REBUILD="${REBUILD:-0}"
NOCACHE="${NOCACHE:-0}"

cd "$(dirname "$0")/.."

if [ "$REBUILD" = "1" ] || [ "$NOCACHE" = "1" ] || [ -z "$(docker images -q "$IMG")" ]; then
  build_args=(build -f docker/web.Dockerfile -t "$IMG")
  [ "$NOCACHE" = "1" ] && build_args+=(--no-cache)
  build_args+=(.)
  echo "==> Building $IMG ..."
  docker "${build_args[@]}"
fi

run_args=(run --rm -it -p "${PORT}:8787" -v taffy-web-data:/data)
for k in TAFFY_API_KEY TAFFY_OPENAI_API_KEY TAFFY_ANTHROPIC_API_KEY TAFFY_GEMINI_API_KEY TAFFY_TOKEN; do
  v="${!k:-}"
  [ -n "$v" ] && run_args+=(-e "$k=$v")
done
run_args+=("$IMG")

echo "==> Running on http://localhost:${PORT}  (Ctrl+C to stop)"
docker "${run_args[@]}"
