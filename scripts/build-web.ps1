#Requires -Version 5.1
<#
.SYNOPSIS
  Build the standalone Taffy Studio web-server binary (no Docker).
.DESCRIPTION
  Produces a single self-contained executable that serves the web UI in the
  browser (the frontend is embedded via rust-embed). Output: dist-out\web\taffy-web.exe
  Run it, your browser opens to the app. Data goes to ./taffy.db by default
  (override with --db-path), keys come from TAFFY_*_API_KEY env vars.
.EXAMPLE
  .\scripts\build-web.ps1
  .\scripts\build-web.ps1 -Run        # build, then launch it
#>
[CmdletBinding()]
param([switch]$Run)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host '==> Installing deps + building frontend (web bundle)...' -ForegroundColor Cyan
pnpm install --frozen-lockfile
pnpm build                       # no TAURI_ENV_PLATFORM => web bundle (webApi)
if ($LASTEXITCODE -ne 0) { throw 'frontend build failed' }

Write-Host '==> Building taffy-web (release)...' -ForegroundColor Cyan
# A running instance locks target\release\taffy-web.exe (Windows won't let
# cargo overwrite it). Stop any first.
Get-Process taffy-web -ErrorAction SilentlyContinue | Stop-Process -Force
cargo build -p taffy-web --release
if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }

New-Item -ItemType Directory -Force dist-out/web | Out-Null
Copy-Item target/release/taffy-web.exe dist-out/web/ -Force
Write-Host '==> Done: dist-out\web\taffy-web.exe' -ForegroundColor Green
Write-Host '    Run it:  .\dist-out\web\taffy-web.exe   (add --host 0.0.0.0 to expose on LAN)'

if ($Run) { & .\dist-out\web\taffy-web.exe }
