#!/usr/bin/env bash
# Generate a Tauri updater signing keypair, install the public key into
# tauri.conf.json, and print exactly what to paste into GitHub Secrets.
#
# Usage:
#   ./scripts/setup-updater.sh                # generate + prompt for passphrase
#   FORCE=1 ./scripts/setup-updater.sh        # overwrite existing key
#   NO_PASSWORD=1 ./scripts/setup-updater.sh  # generate with no passphrase
#                                             # (only for throwaway demos)
set -euo pipefail

# Resolve repo root from this script's location, regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SECRETS_DIR="$REPO_ROOT/secrets"
KEY_PATH="$SECRETS_DIR/taffy-updater.key"
PUB_PATH="$KEY_PATH.pub"
CONF_PATH="$REPO_ROOT/src-tauri/tauri.conf.json"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
magenta(){ printf '\033[35m%s\033[0m\n' "$*"; }

# --- preflight ------------------------------------------------------

if [[ ! -f "$CONF_PATH" ]]; then
  red "ERROR: cannot find $CONF_PATH — are you running this from a repo checkout?"
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  red "ERROR: pnpm not on PATH. Install pnpm first (https://pnpm.io/installation)."
  exit 1
fi

mkdir -p "$SECRETS_DIR"

if [[ -f "$KEY_PATH" && "${FORCE:-0}" != "1" ]]; then
  yellow "A key already exists at $KEY_PATH. Re-run with FORCE=1 to overwrite."
  yellow "(The matching pubkey is at $PUB_PATH if you need to re-read it.)"
  exit 0
fi

# --- generate -------------------------------------------------------

# `tauri signer generate -w <path>` writes <path> and <path>.pub. It will
# prompt for a passphrase unless --no-password is set. We DON'T pass the
# passphrase on the command line — the user types it interactively so it
# never lands in shell history.
args=(tauri signer generate -w "$KEY_PATH")
[[ "${FORCE:-0}" == "1" ]] && args+=(-f)
[[ "${NO_PASSWORD:-0}" == "1" ]] && args+=(--no-password)

cyan "==> Generating updater keypair via pnpm ${args[*]}"
pnpm "${args[@]}"

if [[ ! -f "$PUB_PATH" ]]; then
  red "ERROR: expected pubkey at $PUB_PATH but it isn't there."
  exit 1
fi

# --- patch tauri.conf.json -----------------------------------------

PUB_KEY="$(tr -d '\r\n' < "$PUB_PATH")"

# Prefer python (always present on dev boxes; CLAUDE.md spells out the path
# on this user's machine) over jq because we want to preserve key order and
# field formatting JSON-style across platforms.
PYTHON="${PYTHON:-python3}"
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  PYTHON=python
fi

"$PYTHON" - "$CONF_PATH" "$PUB_KEY" <<'PY'
import json, sys, pathlib
conf_path = pathlib.Path(sys.argv[1])
pubkey    = sys.argv[2]
data = json.loads(conf_path.read_text(encoding='utf-8'))
data.setdefault('plugins', {}).setdefault('updater', {})['pubkey'] = pubkey
# Keep 2-space indent + trailing newline so the file diff stays small.
conf_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
PY

green "==> Installed pubkey into $CONF_PATH"

# --- print the bits the user has to copy to GitHub -----------------

if command -v base64 >/dev/null 2>&1; then
  # GNU coreutils: -w0 keeps it on one line. macOS base64 has no -w; it
  # already emits one line for small inputs, but we still strip newlines
  # to be defensive.
  PRIV_B64="$(base64 -w0 "$KEY_PATH" 2>/dev/null || base64 "$KEY_PATH" | tr -d '\n')"
else
  red "ERROR: base64 not on PATH; cannot encode the private key for you."
  exit 1
fi

echo
magenta "================ COPY THESE INTO GITHUB SECRETS ================"
echo
yellow "Secret name:  TAURI_SIGNING_PRIVATE_KEY"
yellow "Secret value (base64-encoded private key) — one line:"
echo "$PRIV_B64"
echo
yellow "Secret name:  TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
yellow "Secret value: the passphrase you just typed above"
yellow "              (leave EMPTY if you used NO_PASSWORD=1)"
echo
echo "Where to paste them:"
echo "  GitHub repo -> Settings -> Secrets and variables -> Actions ->"
echo "  New repository secret (one per name above)"
echo
magenta "============== ALSO UPDATE tauri.conf.json ENDPOINT ==============="
echo
echo "Open src-tauri/tauri.conf.json and replace the placeholder host in"
echo "plugins.updater.endpoints[0] with your real GitHub owner/repo, e.g.:"
echo
echo "  https://github.com/zuoliangyu/Taffy-Studio/releases/latest/download/latest.json"
echo
echo "Rotation, hosting alternatives, and troubleshooting: see docs/UPDATER.md"
echo
green "Done."
