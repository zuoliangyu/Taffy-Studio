#!/usr/bin/env bash
# Build Android APK (+ AAB) via Docker.
#
# Usage:
#   ./scripts/tasks/build-android.sh             # build
#   ./scripts/tasks/build-android.sh --no-cache  # force a clean rebuild of the image
#
# Runs the multi-stage build in docker/android.Dockerfile, then extracts the
# artifacts to ./dist-out/android/. First build is heavy (~30 min, ~6 GB
# SDK+NDK download) — those layers cache and later builds are fast. Works on
# any host with Docker (macOS / Linux / WSL).
#
# Output: ./dist-out/android/{*.apk, *.aab}.

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

step "Preflight (Android via Docker)"
ensure_docker

step "Building Docker image (android) -- first run is slow"
if [[ $NO_CACHE -eq 1 ]]; then
    docker compose build --no-cache android
else
    docker compose build android
fi

step "Extracting artifacts to dist-out/android/"
mkdir -p dist-out/android
docker compose run --rm android

done_ "Android artifacts:"
find "$ROOT/dist-out/android" \( -name '*.apk' -o -name '*.aab' \) 2>/dev/null | sort
