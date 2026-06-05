#!/usr/bin/env bash
# Unified release builder dispatcher (bash counterpart of build.ps1).
# Interactive when run with no target.
#
#   ./scripts/build.sh                 # interactive menu (target, then mode)
#   ./scripts/build.sh web             # release web build
#   ./scripts/build.sh web --debug     # debug web build
#   ./scripts/build.sh all
#
# Targets:
#   linux    -> Docker (.deb + .AppImage)        [release]
#   android  -> Docker (.apk, debug-signed)       [debug]
#   web      -> single self-contained taffy-web binary
#   windows  -> native NSIS + MSI + portable exe  (Windows host only)
#   all      -> linux + android + web
#
# --debug applies to the native targets (web, windows): an unoptimised, larger,
# faster-to-compile build. Docker linux is always release; Android is debug.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

TARGET=""
DEBUG=0
for a in "$@"; do
    case "$a" in
        --debug)        DEBUG=1 ;;
        -h|--help|help) head -n 18 "$0" | tail -n 17; exit 0 ;;
        *) if [ -z "$TARGET" ]; then TARGET="$a"; else die "Unexpected argument: $a"; fi ;;
    esac
done

# key | description | debuggable(1/0)
TARGETS=(
    "linux|Docker -> .deb + .AppImage  (release)|0"
    "android|Docker -> .apk  (debug-signed)|0"
    "web|single-file taffy-web server binary|1"
    "windows|native NSIS + MSI + portable exe (Windows host)|1"
    "all|linux + android + web|1"
)

# Interactive menu when no target was given.
if [ -z "$TARGET" ]; then
    step "Taffy Studio - build"
    i=0
    declare -a KEYS DBG
    for e in "${TARGETS[@]}"; do
        IFS='|' read -r k d dbg <<<"$e"
        i=$((i + 1)); KEYS[$i]="$k"; DBG[$i]="$dbg"
        printf '  [%d] %-9s %s\n' "$i" "$k" "$d"
    done
    echo
    printf 'Pick a target [1-%d] (blank to cancel): ' "$i"
    read -r pick || true
    [ -z "${pick// /}" ] && { warn "Cancelled."; exit 0; }
    { [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le "$i" ]; } || die "Invalid choice: $pick"
    TARGET="${KEYS[$pick]}"
    if [ "${DBG[$pick]}" = 1 ]; then
        echo
        echo "  [1] release   optimised, smaller  (default)"
        echo "  [2] debug     unoptimised, larger, faster to compile"
        printf 'Build mode [1-2] (blank = release): '
        read -r m || true
        [ "${m// /}" = 2 ] && DEBUG=1
    fi
fi

run_sub() { # name script supports_debug(1/0)
    local name="$1" script="$2" supdbg="$3" dbg=""
    [ "$supdbg" = 1 ] && [ "$DEBUG" = 1 ] && dbg="--debug"
    step "[$name] $(basename "$script")${dbg:+ (debug)}"
    bash "$SCRIPT_DIR/tasks/$script" $dbg
}

case "$TARGET" in
    linux)   run_sub linux   build-linux.sh   0 ;;
    android) run_sub android build-android.sh 0 ;;
    web)     run_sub web     build-web.sh     1 ;;
    windows) run_sub windows build-windows.sh 1 ;;
    all)
        run_sub linux   build-linux.sh   0
        run_sub android build-android.sh 0
        run_sub web     build-web.sh     1
        ;;
    *) die "Unknown target: $TARGET (try: linux | android | web | windows | all | help)" ;;
esac

done_ "All requested builds finished."
