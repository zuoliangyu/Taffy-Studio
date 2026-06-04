#!/usr/bin/env bash
# Mirrors .github/workflows/ci.yml step-for-step.
# Fails fast on the first failing check.

set -euo pipefail

BOLD=$'\033[1m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'; RED=$'\033[31m'; RESET=$'\033[0m'

step() { printf '\n%s==> %s%s\n' "${CYAN}${BOLD}" "$*" "$RESET"; }
ok()   { printf '%s✓ %s%s\n' "$GREEN" "$*" "$RESET"; }
fail() { printf '%s✗ %s%s\n' "$RED" "$*" "$RESET"; exit 1; }

trap 'fail "step failed (exit $?). See output above."' ERR

cd /app

step "1/6  pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile
ok "JS deps installed"

step "2/6  pnpm exec tsc -b   (frontend typecheck)"
pnpm exec tsc -b
ok "Typecheck passed"

step "3/6  pnpm build   (vite production build)"
pnpm build
ok "Frontend bundle built"

step "4/6  cargo fmt --all -- --check"
(cd src-tauri && cargo fmt --all -- --check)
ok "Rust formatting clean"

step "5/6  cargo clippy --all-targets -- -D warnings"
(cd src-tauri && cargo clippy --all-targets -- -D warnings)
ok "Clippy clean (no warnings)"

step "6/6  cargo check --all-targets"
(cd src-tauri && cargo check --all-targets)
ok "Rust check passed"

printf '\n%s%sAll CI checks passed.%s\n' "$GREEN" "$BOLD" "$RESET"
