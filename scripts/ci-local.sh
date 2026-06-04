#!/usr/bin/env bash
# Run the same checks as GitHub Actions CI, inside Docker.
#
# Usage:
#   ./scripts/ci-local.sh           # normal run
#   ./scripts/ci-local.sh --reset   # wipe cached volumes (node_modules / cargo / target)
#   ./scripts/ci-local.sh --no-cache  # rebuild the CI image from scratch
#
# First run builds the CI image (~5-10 min, ~1.5 GB). Subsequent runs reuse
# cached node_modules and cargo registry via named volumes (~2-3 min).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

RESET=0
NO_CACHE=0
for arg in "$@"; do
    case "$arg" in
        --reset)     RESET=1 ;;
        --no-cache)  NO_CACHE=1 ;;
        -h|--help)
            head -n 12 "$0" | tail -n 11
            exit 0
            ;;
        *) die "Unknown flag: $arg" ;;
    esac
done

ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

step "Preflight"
command -v docker >/dev/null || die "Docker not found. Install Docker Desktop."
docker info >/dev/null 2>&1 || die "Docker daemon not running."

if [[ $RESET -eq 1 ]]; then
    step "Wiping CI named volumes"
    docker compose down -v ci 2>&1 || true
    docker volume rm app_ci-cargo app_ci-cargo-git app_ci-target app_ci-node-modules 2>&1 || true
    ok "Volumes removed."
fi

step "Building CI image (first run ~5-10 min)"
if [[ $NO_CACHE -eq 1 ]]; then
    docker compose build --no-cache ci
else
    docker compose build ci
fi

step "Running CI checks (mirrors .github/workflows/ci.yml)"
if docker compose run --rm ci; then
    done_ "Local CI passed. Safe to push."
else
    die "Local CI failed. Fix the failures above before pushing."
fi
