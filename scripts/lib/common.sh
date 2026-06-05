# Shared helpers for the dev / build bash scripts (macOS).
# Source from each entry point:  source "$(dirname "$0")/lib/common.sh"

set -euo pipefail

# --- pretty output ---
if [[ -t 1 ]]; then
    BOLD=$'\033[1m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'
    YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
    BOLD=''; CYAN=''; GREEN=''; YELLOW=''; DIM=''; RESET=''
fi

step()  { printf '\n%s==> %s%s\n' "${CYAN}${BOLD}" "$*" "$RESET"; }
ok()    { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }
warn()  { printf '%s!!  %s%s\n' "$YELLOW" "$*" "$RESET"; }
done_() { printf '\n%s==> %s%s\n' "${GREEN}${BOLD}" "$*" "$RESET"; }
die()   { printf '\n%sERROR: %s%s\n' "$YELLOW" "$*" "$RESET" >&2; exit 1; }

# App root = parent of scripts/. Script lives in scripts/<name>.sh.
app_root() {
    cd "$(dirname "${BASH_SOURCE[1]}")/.."
    pwd
}

# --- toolchain checks ---

ensure_node() {
    command -v node >/dev/null || die "Node.js not found. Install Node 20+ (brew install node)."
    local v major
    v=$(node --version | sed 's/^v//')
    major=${v%%.*}
    [[ $major -ge 18 ]] || die "Node >= 18 required (found v$v)."
    ok "node v$v"
}

ensure_pnpm() {
    if ! command -v pnpm >/dev/null; then
        if command -v corepack >/dev/null; then
            warn "pnpm not found. Enabling via corepack..."
            corepack enable pnpm
        else
            die "pnpm not found. Install with 'npm i -g pnpm' or 'brew install pnpm'."
        fi
    fi
    ok "pnpm v$(pnpm --version)"
}

ensure_rust() {
    command -v cargo >/dev/null || die "Rust not found. Install from https://rustup.rs"
    ok "$(rustc --version)"
}

ensure_docker() {
    command -v docker >/dev/null || die "Docker CLI not found. Install Docker Desktop / Engine."
    # `docker info` exits non-zero if the daemon is not running.
    docker info >/dev/null 2>&1 || die "Docker daemon not responding. Start Docker and retry."
    ok "docker daemon OK"
}

ensure_xcode() {
    command -v xcodebuild >/dev/null || die "Xcode command line tools not found. Run: xcode-select --install"
    # xcodebuild -version exits non-zero if no full Xcode is installed (only CLT).
    if ! xcodebuild -version >/dev/null 2>&1; then
        die "Full Xcode required for iOS builds (not just CLT). Install from the App Store."
    fi
    ok "$(xcodebuild -version | head -n1)"
}

ensure_android_env() {
    local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
    if [[ -z "$sdk" || ! -d "$sdk" ]]; then
        die "ANDROID_HOME not set. Install Android Studio, then:
    export ANDROID_HOME=\$HOME/Library/Android/sdk
    export NDK_HOME=\$ANDROID_HOME/ndk/<version>
  Re-run after sourcing your shell profile."
    fi
    ok "ANDROID_HOME = $sdk"

    if [[ -z "${NDK_HOME:-}" ]]; then
        # Pick the most recent NDK under $sdk/ndk/.
        if [[ -d "$sdk/ndk" ]]; then
            local picked
            picked=$(ls -1 "$sdk/ndk" | sort -V | tail -n1 || true)
            if [[ -n "$picked" ]]; then
                export NDK_HOME="$sdk/ndk/$picked"
                warn "NDK_HOME was not set; auto-using $NDK_HOME"
            fi
        fi
    fi
    [[ -n "${NDK_HOME:-}" && -d "$NDK_HOME" ]] || die "NDK_HOME not set and no NDK found under $sdk/ndk/."
    ok "NDK_HOME     = $NDK_HOME"
}

ensure_android_rust_targets() {
    ok "rustup target add (Android targets)..."
    for t in aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android; do
        rustup target add "$t" >/dev/null 2>&1 || true
    done
    ok "Android Rust targets ready."
}

ensure_ios_rust_targets() {
    ok "rustup target add (iOS targets)..."
    rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios >/dev/null 2>&1 || true
    ok "iOS Rust targets ready."
}

ensure_app_deps() {
    local root="$1"
    if [[ ! -d "$root/node_modules" ]]; then
        step "Installing JS dependencies (first run)..."
        (cd "$root" && pnpm install)
    else
        ok "node_modules present (skipping pnpm install)."
    fi
}
