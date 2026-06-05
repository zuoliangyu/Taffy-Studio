#!/usr/bin/env bash
# Build Windows release artifacts (NSIS installer + MSI) natively.
#
# Usage:
#   ./scripts/build-windows.sh                 # nsis,msi [default]
#   ./scripts/build-windows.sh nsis            # only the NSIS installer
#   ./scripts/build-windows.sh "nsis,msi,app"  # custom bundle list
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
source "$SCRIPT_DIR/lib/common.sh"

case "${1:-}" in
    -h|--help) head -n 9 "$0" | tail -n 8; exit 0 ;;
esac
TARGETS="${1:-nsis,msi}"

ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) : ;;  # Git Bash / MSYS on Windows — OK.
    *) warn "Host is not Windows; tauri can't produce Windows installers here. Continuing anyway." ;;
esac

step "Preflight (Windows build)"
ensure_node; ensure_pnpm; ensure_rust
ensure_app_deps "$ROOT"

step "Building Windows installer ($TARGETS)"
ok "First run compiles all Rust crates from scratch (~10 min); later builds reuse ./target."
(cd "$ROOT" && pnpm tauri build --bundles "$TARGETS")

done_ "Windows artifacts:"
find "$ROOT/target/release/bundle" \( -name '*.exe' -o -name '*.msi' \) 2>/dev/null | sort
