#!/usr/bin/env bash
# Unified release builder for Taffy Studio (macOS host).
#
# Usage:
#   ./scripts/build-mac.sh                # macOS .app + .dmg [default]
#   ./scripts/build-mac.sh mac
#   ./scripts/build-mac.sh ios            # .ipa (sideload-ready)
#   ./scripts/build-mac.sh android        # APK (via Docker, same as Windows host)
#   ./scripts/build-mac.sh linux          # .deb + AppImage (via Docker)
#   ./scripts/build-mac.sh all            # mac + ios + android + linux
#
# Why Mac can build everything: macOS hosts can produce mac/ios natively AND
# run Docker for the Linux/Android Dockerfiles. The only thing they can't easily
# do is native Windows installers (would need cargo-xwin + Windows SDK setup).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET=""
DEBUG=0
for a in "$@"; do
    case "$a" in
        --debug) DEBUG=1 ;;
        *) if [ -z "$TARGET" ]; then TARGET="$a"; else die "Unexpected argument: $a"; fi ;;
    esac
done
TARGET="${TARGET:-mac}"
profile=release; dbg=""
[ "$DEBUG" = 1 ] && { profile=debug; dbg="--debug"; }   # mac/ios native builds only

usage() {
    cat <<EOF
Usage: $0 [mac|ios|android|linux|all|help] [--debug]

  mac      tauri build (.app, .dmg)                                   [default]
  ios      tauri ios build (.ipa for sideload — needs signing team)
  android  Docker -> APK
  linux    Docker -> .deb + AppImage
  all      mac + ios + android + linux
  --debug  unoptimised debug build (mac/ios native targets; larger, faster)
EOF
}

build_mac() {
    step "Preflight (mac build)"
    ensure_node; ensure_pnpm; ensure_rust
    ensure_app_deps "$ROOT"
    step "Building macOS bundle ($profile)"
    (cd "$ROOT" && pnpm tauri build $dbg)
    done_ "macOS artifacts:"
    find "$ROOT/target/$profile/bundle" -maxdepth 2 \( -name '*.app' -o -name '*.dmg' \) | sort
}

build_ios() {
    step "Preflight (iOS build)"
    ensure_node; ensure_pnpm; ensure_rust
    ensure_xcode
    ensure_ios_rust_targets
    ensure_app_deps "$ROOT"
    if [[ ! -d "$ROOT/src-tauri/gen/apple" ]]; then
        step "Initializing iOS project (one-time)"
        (cd "$ROOT" && pnpm tauri ios init)
        warn "Configure Signing Team in Xcode before release builds."
    fi
    step "Building iOS .ipa ($profile)"
    (cd "$ROOT" && pnpm tauri ios build $dbg)
    done_ "iOS artifacts under src-tauri/gen/apple/build/."
}

build_android() {
    step "Preflight (Android via Docker)"
    command -v docker >/dev/null || die "Docker not found. Install Docker Desktop for Mac."
    docker info >/dev/null 2>&1 || die "Docker daemon not running."
    step "Building Android image"
    (cd "$ROOT" && docker compose build android)
    step "Extracting APK"
    mkdir -p "$ROOT/dist-out/android"
    (cd "$ROOT" && docker compose run --rm android)
    done_ "Android artifacts:"
    find "$ROOT/dist-out/android" -name '*.apk' -o -name '*.aab' 2>/dev/null | sort
}

build_linux() {
    step "Preflight (Linux via Docker)"
    command -v docker >/dev/null || die "Docker not found. Install Docker Desktop for Mac."
    docker info >/dev/null 2>&1 || die "Docker daemon not running."
    step "Building Linux image"
    (cd "$ROOT" && docker compose build linux)
    step "Extracting Linux artifacts"
    mkdir -p "$ROOT/dist-out/linux"
    (cd "$ROOT" && docker compose run --rm linux)
    done_ "Linux artifacts:"
    find "$ROOT/dist-out/linux" -name '*.deb' -o -name '*.AppImage' 2>/dev/null | sort
}

case "$TARGET" in
    help|-h|--help) usage; exit 0 ;;
    mac)     build_mac ;;
    ios)     build_ios ;;
    android) build_android ;;
    linux)   build_linux ;;
    all)
        build_mac
        build_ios
        build_android
        build_linux
        ;;
    *) warn "Unknown target: $TARGET"; usage; exit 1 ;;
esac

done_ "All requested builds finished."
