#!/usr/bin/env bash
# Build Windows release artifacts (NSIS installer + MSI) natively.
#
# Usage:
#   ./scripts/tasks/build-windows.sh                 # nsis,msi [default]
#   ./scripts/tasks/build-windows.sh nsis            # only the NSIS installer
#   ./scripts/tasks/build-windows.sh "nsis,msi,app"  # custom bundle list
#
# This is the bash counterpart of build-windows.ps1, for users who drive the
# Windows build from Git Bash / MSYS2 / WSL-with-Windows-toolchain. It still
# requires a Windows host with the MSVC Build Tools + WebView2 (tauri build
# fails with a clear message if they're missing).
#
# Output: target/release/bundle/{*.exe, *.msi}.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

DEBUG=0
TARGETS=""
for a in "$@"; do
    case "$a" in
        --debug)   DEBUG=1 ;;
        -h|--help) head -n 9 "$0" | tail -n 8; exit 0 ;;
        *) if [ -z "$TARGETS" ]; then TARGETS="$a"; else die "Unexpected argument: $a"; fi ;;
    esac
done
TARGETS="${TARGETS:-nsis,msi}"
profile=release
[ "$DEBUG" = 1 ] && profile=debug

ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) : ;;  # Git Bash / MSYS on Windows — OK.
    *) warn "Host is not Windows; tauri can't produce Windows installers here. Continuing anyway." ;;
esac

step "Preflight (Windows build)"
ensure_node; ensure_pnpm; ensure_rust
ensure_app_deps "$ROOT"

step "Building Windows installer ($TARGETS, $profile)"
ok "First run compiles all Rust crates from scratch (~10 min); later builds reuse ./target."
dbg=""; [ "$DEBUG" = 1 ] && dbg="--debug"
(cd "$ROOT" && pnpm tauri build --bundles "$TARGETS" $dbg)

done_ "Installers:"
find "$ROOT/target/$profile/bundle" \( -name '*.exe' -o -name '*.msi' \) 2>/dev/null | sort

# --- Portable build -------------------------------------------------------
# The raw app exe is self-contained (embedded frontend; uses system WebView2),
# so it runs without installation. Copy it out to dist-out/windows/.
product=$(node -p "require('$ROOT/src-tauri/tauri.conf.json').productName")
version=$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")
portable_src=""
for cand in "$product.exe" "taffy-studio.exe"; do
    if [ -f "$ROOT/target/$profile/$cand" ]; then portable_src="$ROOT/target/$profile/$cand"; break; fi
done
if [ -n "$portable_src" ]; then
    mkdir -p "$ROOT/dist-out/windows"
    suffix=""; [ "$DEBUG" = 1 ] && suffix="-debug"
    portable="$ROOT/dist-out/windows/$(echo "$product" | tr ' ' '-')_${version}${suffix}_x64-portable.exe"
    cp "$portable_src" "$portable"
    done_ "Portable (no install needed): $portable"
    ok "Note: needs the WebView2 runtime (built into Win11; Win10 may need it installed once)."
else
    warn "Portable exe not found under target/release (looked for '$product.exe' / 'taffy-studio.exe')."
fi
