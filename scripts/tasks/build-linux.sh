#!/usr/bin/env bash
# Build Linux release artifacts (deb + AppImage) via Docker.
#
# Usage:
#   ./scripts/tasks/build-linux.sh             # build
#   ./scripts/tasks/build-linux.sh --no-cache  # force a clean rebuild of the image
#
# Runs the multi-stage build in docker/linux.Dockerfile, then extracts the
# bundle to ./dist-out/linux/. First build is ~10-15 min; later builds reuse
# the Docker layer cache. Works on any host with Docker (macOS / Linux / WSL).
#
# Output: ./dist-out/linux/{*.deb, *.AppImage, *.rpm}.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

NO_CACHE=0
for arg in "$@"; do
    case "$arg" in
        --no-cache) NO_CACHE=1 ;;
        -h|--help)  head -n 8 "$0" | tail -n 7; exit 0 ;;
        *) die "Unknown flag: $arg" ;;
    esac
done

ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

step "Preflight (Linux via Docker)"
ensure_docker

step "Building Docker image (linux)"
if [[ $NO_CACHE -eq 1 ]]; then
    docker compose build --no-cache linux
else
    docker compose build linux
fi

step "Extracting artifacts to dist-out/linux/"
mkdir -p dist-out/linux
docker compose run --rm linux

done_ "Linux artifacts:"
find "$ROOT/dist-out/linux" \( -name '*.deb' -o -name '*.AppImage' -o -name '*.rpm' \) 2>/dev/null | sort
