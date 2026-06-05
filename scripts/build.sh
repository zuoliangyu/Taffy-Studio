#!/usr/bin/env bash
# Unified release builder dispatcher (bash counterpart of build.ps1).
#
# Usage:
#   ./scripts/build.sh [target]
#
#   linux    -> Docker (.deb + AppImage)                                [default]
#   android  -> Docker (.apk + .aab)
#   web      -> single self-contained taffy-web binary
#   windows  -> native NSIS + MSI   (only on a Windows host)
#   all      -> linux + android + web
#   help     -> show this help
#
# Note on the matrix: this dispatcher covers the targets buildable from a
# Linux/macOS host. macOS + iOS are Apple-only — use scripts/build-mac.sh on a
# real Mac. Windows installers need a Windows host — use build-windows.* there.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

TARGET="${1:-linux}"

run_sub() {
    local name="$1" script="$2"; shift 2
    step "[$name] $script"
    bash "$script" "$@"
}

case "$TARGET" in
    help|-h|--help) head -n 16 "$0" | tail -n 15; exit 0 ;;
    linux)   run_sub linux   "$SCRIPT_DIR/build-linux.sh" ;;
    android) run_sub android "$SCRIPT_DIR/build-android.sh" ;;
    web)     run_sub web     "$SCRIPT_DIR/build-web.sh" ;;
    windows) run_sub windows "$SCRIPT_DIR/build-windows.sh" ;;
    all)
        run_sub linux   "$SCRIPT_DIR/build-linux.sh"
        run_sub android "$SCRIPT_DIR/build-android.sh"
        run_sub web     "$SCRIPT_DIR/build-web.sh"
        ;;
    *) die "Unknown target: $TARGET (try: linux | android | web | windows | all | help)" ;;
esac

done_ "All requested builds finished."
