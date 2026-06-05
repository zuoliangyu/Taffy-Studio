#!/usr/bin/env bash
# Build (and optionally push) the Taffy Studio web-server Docker image.
#
# Unlike dev-docker.sh (build + run for local testing), this only builds /
# publishes the image.
#
#   ./scripts/tasks/build-docker.sh                              # -> taffy-web:latest
#   TAG=ghcr.io/you/taffy-web:0.1.0 PUSH=1 ./scripts/tasks/build-docker.sh
#   NOCACHE=1 ./scripts/tasks/build-docker.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

TAG="${TAG:-taffy-web:latest}"
PUSH="${PUSH:-0}"
NOCACHE="${NOCACHE:-0}"

build_args=(build -f docker/web.Dockerfile -t "$TAG")
[ "$NOCACHE" = "1" ] && build_args+=(--no-cache)
build_args+=(.)

echo "==> Building $TAG ..."
docker "${build_args[@]}"

if [ "$PUSH" = "1" ]; then
  echo "==> Pushing $TAG ..."
  docker push "$TAG"
fi

echo "==> Done: $TAG"
