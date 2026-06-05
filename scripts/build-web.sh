#!/usr/bin/env bash
# Build the standalone Taffy Studio web-server binary (no Docker).
#
# Produces a single self-contained executable that serves the web UI in the
# browser (frontend embedded via rust-embed). Output: dist-out/web/taffy-web
# Run it; your browser opens to the app. Data goes to ./taffy.db by default
# (override with --db-path); provider keys come from TAFFY_*_API_KEY env vars.
#
#   ./scripts/build-web.sh           # release build
#   ./scripts/build-web.sh --debug   # unoptimised debug build (larger, faster compile)
#   RUN=1 ./scripts/build-web.sh     # build, then launch it
set -euo pipefail
cd "$(dirname "$0")/.."

profile=release
cargo_release=--release
if [ "${1:-}" = "--debug" ]; then profile=debug; cargo_release=; fi

echo '==> Installing deps + building frontend (web bundle)...'
pnpm install --frozen-lockfile
pnpm build                       # no TAURI_ENV_PLATFORM => web bundle (webApi)

echo "==> Building taffy-web ($profile)..."
# Stop any running instance so cargo can overwrite the binary.
pkill -x taffy-web 2>/dev/null || true
cargo build -p taffy-web $cargo_release

mkdir -p dist-out/web
cp "target/$profile/taffy-web" dist-out/web/
echo '==> Done: dist-out/web/taffy-web'
echo '    Run it:  ./dist-out/web/taffy-web   (add --host 0.0.0.0 to expose on LAN)'

if [ "${RUN:-0}" = "1" ]; then
  exec ./dist-out/web/taffy-web
fi
