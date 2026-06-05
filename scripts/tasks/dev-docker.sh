#!/usr/bin/env bash
# Build + run the taffy-web (self-hosted web) image locally for testing.
#
#   ./scripts/tasks/dev-docker.sh                 # build + run on :8787
#   PORT=9000 ./scripts/tasks/dev-docker.sh
#   TAFFY_TOKEN=secret ./scripts/tasks/dev-docker.sh
#   NOCACHE=1 ./scripts/tasks/dev-docker.sh       # force a clean rebuild
#
# Provider keys present in your shell (TAFFY_API_KEY / TAFFY_OPENAI_API_KEY /
# TAFFY_ANTHROPIC_API_KEY / TAFFY_GEMINI_API_KEY) are forwarded into the
# container; the server injects them into LLM requests.
set -euo pipefail

PORT="${PORT:-8787}"
IMG="taffy-web:dev"
NOCACHE="${NOCACHE:-0}"

cd "$(dirname "$0")/../.."

# Always build. Docker's layer cache makes this near-instant when nothing
# changed and only rebuilds what changed, so you always run the latest code.
build_args=(build -f docker/web.Dockerfile -t "$IMG")
[ "$NOCACHE" = "1" ] && build_args+=(--no-cache)
build_args+=(.)
echo "==> Building $IMG ..."
docker "${build_args[@]}"

run_args=(run --rm -it -p "${PORT}:8787" -v taffy-web-data:/data)
for k in TAFFY_API_KEY TAFFY_OPENAI_API_KEY TAFFY_ANTHROPIC_API_KEY TAFFY_GEMINI_API_KEY TAFFY_TOKEN; do
  v="${!k:-}"
  [ -n "$v" ] && run_args+=(-e "$k=$v")
done
run_args+=("$IMG")

echo "==> Running on http://localhost:${PORT}  (Ctrl+C to stop)"
docker "${run_args[@]}"
