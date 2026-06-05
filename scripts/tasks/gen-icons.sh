#!/usr/bin/env bash
# Generate platform icons for Tauri (bash counterpart of gen-icons.ps1).
#
# Usage:
#   ./scripts/tasks/gen-icons.sh                      # draw a placeholder, then generate
#   ./scripts/tasks/gen-icons.sh ~/art/logo-1024.png  # use your own master PNG
#   LETTERS=AI COLOR=30,30,40 ./scripts/tasks/gen-icons.sh
#
# If you pass a master PNG it's used directly. Otherwise a 1024x1024 placeholder
# is drawn (needs ImageMagick: `brew install imagemagick` / `apt install
# imagemagick`). `tauri icon` then produces every platform variant: 32x32.png,
# 128x128.png, icon.icns, icon.ico, Square*Logo.png, Android mipmaps, iOS set.
#
# Output: src-tauri/icons/*.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

case "${1:-}" in
    -h|--help) head -n 12 "$0" | tail -n 11; exit 0 ;;
esac

ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ICONS_DIR="$ROOT/src-tauri/icons"
mkdir -p "$ICONS_DIR"

INPUT="${1:-}"
LETTERS="${LETTERS:-FC}"
COLOR="${COLOR:-79,140,255}"

if [[ -z "$INPUT" ]]; then
    # Need ImageMagick to draw the placeholder. `magick` (v7) or `convert` (v6).
    if command -v magick >/dev/null; then IM=magick
    elif command -v convert >/dev/null; then IM=convert
    else
        die "No master image given and ImageMagick not found.
  Install it (brew install imagemagick / apt-get install imagemagick) or pass a PNG:
    ./scripts/tasks/gen-icons.sh /path/to/logo-1024.png"
    fi

    IFS=',' read -r R G B <<<"$COLOR"
    [[ -n "${R:-}" && -n "${G:-}" && -n "${B:-}" ]] || die "COLOR must be R,G,B (got '$COLOR')."

    # Font size that fits 2-3 letters comfortably (mirrors gen-icons.ps1).
    local_len=${#LETTERS}
    pointsize=$(( 480 - 70 * local_len ))
    [[ $pointsize -lt 180 ]] && pointsize=180

    INPUT="$ICONS_DIR/master.png"
    step "Drawing placeholder master.png ('$LETTERS', bg $COLOR)"
    "$IM" -size 1024x1024 "xc:rgb($R,$G,$B)" \
        -gravity center -fill white -pointsize "$pointsize" -annotate 0 "$LETTERS" \
        "$INPUT"
    ok "Wrote $INPUT"
else
    [[ -f "$INPUT" ]] || die "Input not found: $INPUT"
    INPUT="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
    ok "Using master image: $INPUT"
fi

step "Generating platform icons (tauri icon)"
(cd "$ROOT" && pnpm tauri icon "$INPUT")

done_ "Icons under $ICONS_DIR"
ls -1 "$ICONS_DIR"
