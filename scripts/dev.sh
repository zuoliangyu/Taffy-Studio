#!/usr/bin/env bash
# Unified dev launcher (bash counterpart of dev.ps1). Interactive when run with
# no target.
#
#   ./scripts/dev.sh             # interactive menu
#   ./scripts/dev.sh desktop     # tauri dev (native window, hot-reload)
#   ./scripts/dev.sh android     # tauri android dev (emulator or USB device)
#   ./scripts/dev.sh ios         # tauri ios dev (macOS + Xcode only)
#
# Dev always runs on the local machine (Docker has no GUI) and is always a debug
# build. On macOS this drives ios/android too; on Linux, desktop + android.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

case "${1:-}" in
    -h|--help|help) head -n 14 "$0" | tail -n 13; exit 0 ;;
esac
TARGET="${1:-}"

# key | description
MENU=(
    "desktop|tauri dev - native window, hot-reload"
    "android|tauri android dev - emulator or USB device"
    "ios|tauri ios dev - macOS + Xcode only"
)

if [ -z "$TARGET" ]; then
    step "Taffy Studio - dev"
    i=0
    declare -a KEYS
    for e in "${MENU[@]}"; do
        IFS='|' read -r k d <<<"$e"
        i=$((i + 1)); KEYS[$i]="$k"
        printf '  [%d] %-9s %s\n' "$i" "$k" "$d"
    done
    echo
    printf 'Pick a target [1-%d] (blank to cancel): ' "$i"
    read -r pick || true
    [ -z "${pick// /}" ] && { warn "Cancelled."; exit 0; }
    { [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le "$i" ]; } || die "Invalid choice: $pick"
    TARGET="${KEYS[$pick]}"
fi

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
        [[ "$(uname -s)" == "Darwin" ]] || die "iOS dev requires macOS + Xcode. Use a Mac: ./scripts/tasks/dev-mac.sh ios"
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
