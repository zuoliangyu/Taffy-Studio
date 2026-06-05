#!/usr/bin/env bash
# Interactively delete Taffy Studio build artifacts / caches to reclaim disk.
#
#   ./scripts/clean.sh             # interactive menu
#   ./scripts/clean.sh --all       # pre-select everything (still confirms)
#   ./scripts/clean.sh --all --yes # non-interactive
#
# Lists each cleanable item with its size; you pick which to remove by number.
# Nothing is deleted without an explicit selection and confirmation.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

ALL=0
YES=0
for a in "$@"; do
    case "$a" in
        --all)     ALL=1 ;;
        --yes|-y)  YES=1 ;;
        -h|--help) head -n 8 "$0" | tail -n 7; exit 0 ;;
        *) die "Unknown flag: $a" ;;
    esac
done

# name | note | space-separated relative paths
ITEMS=(
    "Windows / macOS installers|.exe .msi .app .dmg (inside target/)|target/release/bundle"
    "Linux packages|.deb .AppImage .rpm|dist-out/linux"
    "Android packages|.apk .aab|dist-out/android"
    "Web binary|taffy-web[.exe]|dist-out/web"
    "iOS packages|.ipa|dist-out/ios"
    "ALL packaged output|the whole dist-out/ folder|dist-out"
    "Rust build cache|HUGE; next build recompiles from scratch|target src-tauri/target"
    "Frontend build|vite output; pnpm build regenerates|dist"
    "TypeScript build info|incremental tsc cache|tsconfig.tsbuildinfo tsconfig.node.tsbuildinfo"
    "Generated mobile projects|tauri *:init regenerates|src-tauri/gen"
    "node_modules|pnpm install refetches|node_modules"
    "pnpm store cache|local pnpm content store|.pnpm-store"
)

human() { # bytes -> human-readable
    local b="$1"
    if   [ "$b" -ge 1073741824 ]; then awk "BEGIN{printf \"%.1f GB\", $b/1073741824}"
    elif [ "$b" -ge 1048576 ];    then awk "BEGIN{printf \"%.0f MB\", $b/1048576}"
    elif [ "$b" -gt 0 ];          then awk "BEGIN{printf \"%.0f KB\", $b/1024}"
    else echo "-"; fi
}
path_size() { # paths... -> total bytes (du -sk is portable: macOS + Linux + Git Bash)
    local total=0 p kb
    for p in "$@"; do
        if [ -e "$ROOT/$p" ]; then
            kb=$(du -sk "$ROOT/$p" 2>/dev/null | awk '{print $1}')
            total=$(( total + ${kb:-0} * 1024 ))
        fi
    done
    echo "$total"
}
any_exists() { local p; for p in "$@"; do [ -e "$ROOT/$p" ] && return 0; done; return 1; }

step "Taffy Studio - clean build artifacts"
ok "Scanning sizes (the Rust cache may take a few seconds)..."
echo

declare -a R_NAME R_NOTE R_PATHS R_SIZE R_EXISTS
i=0
for entry in "${ITEMS[@]}"; do
    IFS='|' read -r name note paths <<<"$entry"
    i=$((i + 1))
    R_NAME[$i]="$name"; R_NOTE[$i]="$note"; R_PATHS[$i]="$paths"
    if any_exists $paths; then
        R_EXISTS[$i]=1; R_SIZE[$i]=$(path_size $paths)
        tag=$(printf '%8s' "$(human "${R_SIZE[$i]}")")
    else
        R_EXISTS[$i]=0; R_SIZE[$i]=0; tag=' (none)'
    fi
    printf '  [%2d] %-28s %s   %s\n' "$i" "$name" "$tag" "$note"
done
echo

selectable=0
for k in $(seq 1 "$i"); do [ "${R_EXISTS[$k]}" = 1 ] && selectable=1; done
[ "$selectable" = 1 ] || { done_ "Nothing to clean - all clear."; exit 0; }

chosen=()
if [ "$ALL" = 1 ]; then
    for k in $(seq 1 "$i"); do [ "${R_EXISTS[$k]}" = 1 ] && chosen+=("$k"); done
else
    printf 'Enter numbers to delete (e.g. 2,3,7), "all", or blank to cancel: '
    read -r ans || true
    if [ -z "${ans// /}" ]; then warn "Cancelled."; exit 0; fi
    if [ "$(echo "$ans" | tr '[:upper:]' '[:lower:]' | tr -d ' ')" = "all" ]; then
        for k in $(seq 1 "$i"); do [ "${R_EXISTS[$k]}" = 1 ] && chosen+=("$k"); done
    else
        for tok in $(echo "$ans" | tr ',' ' '); do
            [[ "$tok" =~ ^[0-9]+$ ]] || continue
            if [ "$tok" -ge 1 ] && [ "$tok" -le "$i" ] && [ "${R_EXISTS[$tok]}" = 1 ]; then chosen+=("$tok"); fi
        done
        [ "${#chosen[@]}" -gt 0 ] || { warn "No valid present items selected. Cancelled."; exit 0; }
    fi
fi

# de-duplicate selection
IFS=$'\n' chosen=($(printf '%s\n' "${chosen[@]}" | sort -un)); unset IFS

total=0
for k in "${chosen[@]}"; do total=$(( total + R_SIZE[k] )); done
echo
step "Will delete ${#chosen[@]} item(s), freeing ~$(human "$total"):"
for k in "${chosen[@]}"; do printf '  - %s  (%s)\n' "${R_NAME[$k]}" "$(human "${R_SIZE[$k]}")"; done
echo

if [ "$YES" != 1 ]; then
    printf 'Proceed? type "y" to delete: '
    read -r confirm || true
    [ "$(echo "${confirm:-}" | tr '[:upper:]' '[:lower:]')" = "y" ] || { warn "Cancelled - nothing deleted."; exit 0; }
fi

for k in "${chosen[@]}"; do
    for p in ${R_PATHS[$k]}; do
        [ -e "$ROOT/$p" ] || continue
        rm -rf "$ROOT/$p" && ok "removed $p"
    done
done
done_ "Done. Freed ~$(human "$total")."
