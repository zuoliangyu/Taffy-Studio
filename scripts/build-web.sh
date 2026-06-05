#!/usr/bin/env bash
# Build the standalone Taffy Studio web-server binary (no Docker).
#
# Produces a single self-contained executable that serves the web UI in the
# browser (frontend embedded via rust-embed). Output: dist-out/web/taffy-web
# Run it; your browser opens to the app. Data goes to ./taffy.db by default
# (override with --db-path); provider keys come from TAFFY_*_API_KEY env vars.
#
#   ./scripts/build-web.sh          # build
#   RUN=1 ./scripts/build-web.sh    # build, then launch it
set -euo pipefail
cd "$(dirname "$0")/.."

echo '==> Installing deps + building frontend (web bundle)...'
pnpm install --frozen-lockfile
pnpm build                       # no TAURI_ENV_PLATFORM => web bundle (webApi)

echo '==> Building taffy-web (release)...'
# Stop any running instance so cargo can overwrite the binary.
pkill -x taffy-web 2>/dev/null || true
cargo build -p taffy-web --release

mkdir -p dist-out/web
cp target/release/taffy-web dist-out/web/
echo '==> Done: dist-out/web/taffy-web'
echo '    Run it:  ./dist-out/web/taffy-web   (add --host 0.0.0.0 to expose on LAN)'

if [ "${RUN:-0}" = "1" ]; then
  exec ./dist-out/web/taffy-web
fi
