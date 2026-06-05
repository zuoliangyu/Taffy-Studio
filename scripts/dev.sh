#!/usr/bin/env bash
# Unified dev launcher (bash counterpart of dev.ps1).
#
# Usage:
#   ./scripts/dev.sh [target]
#
#   desktop  -> tauri dev (native window, hot-reload)                   [default]
#   android  -> tauri android dev (emulator or USB device)
#   ios      -> tauri ios dev   (macOS + Xcode only)
#   help     -> show this help
#
# Dev always runs on the local machine (Docker has no GUI and is slower to
# iterate). On macOS this also drives ios/android; on Linux, desktop + android.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

TARGET="${1:-desktop}"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

case "$TARGET" in
    help|-h|--help) head -n 12 "$0" | tail -n 11; exit 0 ;;
esac

step "Preflight"
ensure_node; ensure_pnpm; ensure_rust
ensure_app_deps "$ROOT"

case "$TARGET" in
    desktop)
        step "Starting desktop dev (tauri dev)"
        ok "First run compiles ~400 Rust crates and may take 5-10 min."
        (cd "$ROOT" && pnpm tauri dev)
        ;;

    android)
        ensure_android_env
        ensure_android_rust_targets
        if [[ ! -d "$ROOT/src-tauri/gen/android" ]]; then
            step "Initializing Android project (one-time)"
            (cd "$ROOT" && pnpm tauri android init)
        fi
        step "Starting Android dev"
        ok "Make sure an emulator is running or a device is attached via USB (adb devices)."
        (cd "$ROOT" && pnpm tauri android dev)
        ;;

    ios)
        [[ "$(uname -s)" == "Darwin" ]] || die "iOS dev requires macOS + Xcode. Use a Mac: ./scripts/dev-mac.sh ios"
        ensure_xcode
        ensure_ios_rust_targets
        if [[ ! -d "$ROOT/src-tauri/gen/apple" ]]; then
            step "Initializing iOS project (one-time)"
            (cd "$ROOT" && pnpm tauri ios init)
            warn "Configure Signing Team in Xcode before release builds."
        fi
        step "Starting iOS dev"
        (cd "$ROOT" && pnpm tauri ios dev)
        ;;

    *) die "Unknown target: $TARGET (try: desktop | android | ios | help)" ;;
esac

done_ "dev session ended."
