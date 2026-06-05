#!/usr/bin/env bash
# Build the standalone Taffy Studio web-server binary (no Docker).
#
# Produces a single self-contained executable that serves the web UI in the
# browser (frontend embedded via rust-embed). Output: dist-out/web/taffy-web
# Run it; your browser opens to the app. Data goes to ./taffy.db by default
# (override with --db-path); provider keys come from TAFFY_*_API_KEY env vars.
#
#   ./scripts/tasks/build-web.sh             # release build (native arch — fast)
#   ./scripts/tasks/build-web.sh --debug     # unoptimised debug build (larger, faster compile)
#   ./scripts/tasks/build-web.sh --universal # macOS only: lipo'd arm64+x86_64 fat binary (matches CI release)
#   RUN=1 ./scripts/tasks/build-web.sh       # build, then launch it
set -euo pipefail
cd "$(dirname "$0")/../.."

profile=release
cargo_release=--release
universal=0
for a in "$@"; do
  case "$a" in
    --debug)     profile=debug; cargo_release= ;;
    --universal) universal=1 ;;
    *) echo "Unknown argument: $a (try --debug / --universal)" >&2; exit 1 ;;
  esac
done

echo '==> Installing deps + building frontend (web bundle)...'
pnpm install --frozen-lockfile
pnpm build                       # no TAURI_ENV_PLATFORM => web bundle (webApi)

# Stop any running instance so cargo can overwrite the binary.
pkill -x taffy-web 2>/dev/null || true
mkdir -p dist-out/web

if [ "$universal" = 1 ]; then
  # Universal macOS binary — same shape as the CI release artifact. Builds both
  # apple-darwin arches on the host and lipo-fuses them into one fat Mach-O.
  [ "$(uname -s)" = "Darwin" ] || { echo "--universal is macOS-only (lipo)." >&2; exit 1; }
  echo "==> Building universal taffy-web ($profile: arm64 + x86_64)..."
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null 2>&1 || true
  cargo build -p taffy-web $cargo_release --target aarch64-apple-darwin
  cargo build -p taffy-web $cargo_release --target x86_64-apple-darwin
  lipo -create \
    "target/aarch64-apple-darwin/$profile/taffy-web" \
    "target/x86_64-apple-darwin/$profile/taffy-web" \
    -output dist-out/web/taffy-web
else
  echo "==> Building taffy-web ($profile)..."
  cargo build -p taffy-web $cargo_release
  cp "target/$profile/taffy-web" dist-out/web/
fi
echo '==> Done: dist-out/web/taffy-web'
echo '    Run it:  ./dist-out/web/taffy-web   (add --host 0.0.0.0 to expose on LAN)'

if [ "${RUN:-0}" = "1" ]; then
  exec ./dist-out/web/taffy-web
fi
