#!/usr/bin/env bash
# Unified dev launcher for Taffy Studio (macOS host).
#
# Usage:
#   ./scripts/tasks/dev-mac.sh                # desktop (Mac native window)
#   ./scripts/tasks/dev-mac.sh desktop
#   ./scripts/tasks/dev-mac.sh ios            # iOS simulator or device
#   ./scripts/tasks/dev-mac.sh android        # emulator or USB device

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

TARGET="${1:-desktop}"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

usage() {
    cat <<EOF
Usage: $0 [desktop|ios|android|help]

  desktop  tauri dev — macOS native window with hot-reload. [default]
  ios      tauri ios dev — pick a simulator/device in Xcode UI when prompted.
  android  tauri android dev — needs ANDROID_HOME and an attached emulator/device.
EOF
}

case "$TARGET" in
    help|-h|--help) usage; exit 0 ;;
esac

step "Preflight"
ensure_node
ensure_pnpm
ensure_rust
ensure_app_deps "$ROOT"

case "$TARGET" in
    desktop)
        step "Starting desktop dev (tauri dev)"
        ok "First run compiles ~400 Rust crates — go grab a coffee."
        (cd "$ROOT" && pnpm tauri dev)
        ;;
    ios)
        ensure_xcode
        ensure_ios_rust_targets
        if [[ ! -d "$ROOT/src-tauri/gen/apple" ]]; then
            step "Initializing iOS project (one-time)"
            (cd "$ROOT" && pnpm tauri ios init)
            warn "Open src-tauri/gen/apple/*.xcodeproj once, pick your Signing Team, then re-run."
        fi
        step "Starting iOS dev"
        (cd "$ROOT" && pnpm tauri ios dev)
        ;;
    android)
        ensure_android_env
        ensure_android_rust_targets
        if [[ ! -d "$ROOT/src-tauri/gen/android" ]]; then
            step "Initializing Android project (one-time)"
            (cd "$ROOT" && pnpm tauri android init)
        fi
        step "Starting Android dev"
        ok "Make sure an emulator is running or a device is attached (adb devices)."
        (cd "$ROOT" && pnpm tauri android dev)
        ;;
    *)
        warn "Unknown target: $TARGET"
        usage
        exit 1
        ;;
esac

done_ "dev session ended."
