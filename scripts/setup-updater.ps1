# Generate a Tauri updater signing keypair, install the public key into
# tauri.conf.json, and print exactly what to paste into GitHub Secrets.
#
# This script is idempotent-on-rerun via the -Force switch: it won't
# overwrite an existing private key unless asked.
#
# Run from anywhere in the repo:
#   .\scripts\setup-updater.ps1
#   .\scripts\setup-updater.ps1 -Force        # regenerate even if key exists
#   .\scripts\setup-updater.ps1 -NoPassword   # generate a key with no passphrase
#                                              # (only use for throwaway demos)

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$NoPassword
)

$ErrorActionPreference = 'Stop'

# Resolve repo root from this script's location, regardless of cwd.
$repoRoot   = Split-Path -Parent $PSScriptRoot
$secretsDir = Join-Path $repoRoot 'secrets'
$keyPath    = Join-Path $secretsDir 'taffy-updater.key'
$pubPath    = "$keyPath.pub"
$confPath   = Join-Path $repoRoot 'src-tauri\tauri.conf.json'

# --- preflight ------------------------------------------------------

if (-not (Test-Path $confPath)) {
    Write-Host "ERROR: cannot find $confPath — are you running this from a repo checkout?" -ForegroundColor Red
    exit 1
}

# pnpm needs to resolve `tauri signer` via @tauri-apps/cli.
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
    Write-Host "ERROR: pnpm not on PATH. Install pnpm first (https://pnpm.io/installation)." -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null

if ((Test-Path $keyPath) -and -not $Force) {
    Write-Host "A key already exists at $keyPath. Re-run with -Force to overwrite." -ForegroundColor Yellow
    Write-Host "(The matching pubkey is at $pubPath if you need to re-read it.)" -ForegroundColor Yellow
    exit 0
}

# --- generate -------------------------------------------------------

# `tauri signer generate -w <path>` writes <path> and <path>.pub. It will
# prompt for a passphrase unless --no-password is set. We DON'T pass the
# passphrase on the command line — the user types it interactively so it
# never lands in shell history.
$args = @('tauri', 'signer', 'generate', '-w', $keyPath)
if ($Force)      { $args += '-f' }
if ($NoPassword) { $args += '--no-password' }

Write-Host "==> Generating updater keypair via pnpm $($args -join ' ')" -ForegroundColor Cyan
& pnpm @args
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: tauri signer generate failed (exit $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
}

if (-not (Test-Path $pubPath)) {
    Write-Host "ERROR: expected pubkey at $pubPath but it isn't there." -ForegroundColor Red
    exit 1
}

# --- patch tauri.conf.json -----------------------------------------

$pubKey = (Get-Content -Raw -Path $pubPath).Trim()

$conf = Get-Content -Raw -Path $confPath | ConvertFrom-Json
if (-not $conf.plugins)         { $conf | Add-Member -NotePropertyName plugins -NotePropertyValue @{} }
if (-not $conf.plugins.updater) { $conf.plugins | Add-Member -NotePropertyName updater -NotePropertyValue @{} }
$conf.plugins.updater.pubkey = $pubKey
$conf | ConvertTo-Json -Depth 32 | Set-Content -Path $confPath -Encoding utf8

Write-Host "==> Installed pubkey into $confPath" -ForegroundColor Green

# --- print the bits the user has to copy to GitHub ----------------

$privBytes  = [IO.File]::ReadAllBytes($keyPath)
$privBase64 = [Convert]::ToBase64String($privBytes)

Write-Host ""
Write-Host "================ COPY THESE INTO GITHUB SECRETS ================" -ForegroundColor Magenta
Write-Host ""
Write-Host "Secret name:  TAURI_SIGNING_PRIVATE_KEY"                          -ForegroundColor Yellow
Write-Host "Secret value (base64-encoded private key) — one line:"            -ForegroundColor Yellow
Write-Host $privBase64
Write-Host ""
Write-Host "Secret name:  TAURI_SIGNING_PRIVATE_KEY_PASSWORD"                 -ForegroundColor Yellow
Write-Host "Secret value: the passphrase you just typed above"                -ForegroundColor Yellow
Write-Host "              (leave EMPTY if you used -NoPassword)"              -ForegroundColor Yellow
Write-Host ""
Write-Host "Where to paste them:"
Write-Host "  GitHub repo -> Settings -> Secrets and variables -> Actions ->"
Write-Host "  New repository secret (one per name above)"
Write-Host ""
Write-Host "============== ALSO UPDATE tauri.conf.json ENDPOINT ===============" -ForegroundColor Magenta
Write-Host ""
Write-Host "Open src-tauri/tauri.conf.json and replace the placeholder host in"
Write-Host "plugins.updater.endpoints[0] with your real GitHub owner/repo, e.g.:"
Write-Host ""
Write-Host '  https://github.com/myhandle/taffy-studio/releases/latest/download/latest.json'
Write-Host ""
Write-Host "Rotation, hosting alternatives, and troubleshooting: see docs/UPDATER.md"
Write-Host ""
Write-Host "Done." -ForegroundColor Green
