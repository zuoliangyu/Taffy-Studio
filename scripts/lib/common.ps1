#Requires -Version 5.1
# Shared helpers for the dev / build PowerShell scripts.
# Dot-source this from each entry point:  . "$PSScriptRoot\lib\common.ps1"

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "    $Message" -ForegroundColor DarkGray
}

function Write-Warn([string]$Message) {
    Write-Host "!!  $Message" -ForegroundColor Yellow
}

function Write-Done([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Green
}

function Test-Cmd([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# App root = parent of scripts/. $PSScriptRoot here = .../scripts/lib
function Get-AppRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

# --- toolchain checks ---

function Ensure-Node {
    if (-not (Test-Cmd 'node')) {
        throw "Node.js not found. Install Node 20+ from https://nodejs.org/ then reopen the terminal."
    }
    $raw = (& node --version).Trim()
    $version = $raw -replace '^v',''
    $major = [int]($version -split '\.')[0]
    if ($major -lt 18) {
        throw "Node >= 18 required (found v$version). Upgrade from https://nodejs.org/."
    }
    Write-Ok "node v$version"
}

function Ensure-Pnpm {
    if (Test-Cmd 'pnpm') {
        $v = (& pnpm --version).Trim()
        Write-Ok "pnpm v$v"
        return
    }
    if (Test-Cmd 'corepack') {
        Write-Warn "pnpm not found. Trying 'corepack enable pnpm'..."
        & corepack enable pnpm 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0 -and (Test-Cmd 'pnpm')) {
            $v = (& pnpm --version).Trim()
            Write-Ok "pnpm v$v (via corepack)"
            return
        }
    }
    throw "pnpm not found. Run 'npm install -g pnpm' or enable corepack (Node 16.10+)."
}

function Ensure-Rust {
    if (-not (Test-Cmd 'cargo')) {
        throw "Rust not found. Install from https://rustup.rs (run rustup-init.exe, then reopen terminal)."
    }
    $v = (& rustc --version).Trim()
    Write-Ok $v
}

function Ensure-Docker {
    if (-not (Test-Cmd 'docker')) {
        throw "Docker CLI not found. Install Docker Desktop from https://www.docker.com/products/docker-desktop/."
    }
    # `docker info` exits non-zero if the daemon is not running.
    & docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker daemon not responding. Start Docker Desktop and wait for the whale icon to settle."
    }
    Write-Ok "docker daemon OK"
}

function Ensure-AndroidEnv {
    # tauri-cli reads ANDROID_HOME and NDK_HOME (or NDK_VERSION/NDK in ANDROID_HOME/ndk/<v>).
    $sdk = $env:ANDROID_HOME
    if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
    if (-not $sdk -or -not (Test-Path $sdk)) {
        throw @"
ANDROID_HOME not set or path missing.

Easiest fix on Windows:
  1. Install Android Studio: https://developer.android.com/studio
  2. Open SDK Manager, install: Platform 34, Build-Tools 34.0.0, NDK (Side by side)
  3. Set env vars (User scope):
       ANDROID_HOME = C:\Users\$env:USERNAME\AppData\Local\Android\Sdk
       NDK_HOME     = %ANDROID_HOME%\ndk\<the-version-you-installed>
  4. Reopen the terminal.
"@
    }
    Write-Ok "ANDROID_HOME = $sdk"

    $ndk = $env:NDK_HOME
    if (-not $ndk) {
        # Try to autodetect the most recent NDK under $sdk\ndk\.
        $ndkRoot = Join-Path $sdk 'ndk'
        if (Test-Path $ndkRoot) {
            $candidate = Get-ChildItem $ndkRoot -Directory |
                Sort-Object Name -Descending |
                Select-Object -First 1
            if ($candidate) {
                $ndk = $candidate.FullName
                $env:NDK_HOME = $ndk
                Write-Warn "NDK_HOME was not set; auto-using $ndk (set it permanently to silence this)."
            }
        }
    }
    if (-not $ndk -or -not (Test-Path $ndk)) {
        throw "NDK_HOME not set and no NDK found under $sdk\ndk\. Install NDK via Android Studio SDK Manager."
    }
    Write-Ok "NDK_HOME     = $ndk"
}

function Ensure-AndroidRustTargets {
    Write-Ok "rustup target add (Android targets)..."
    $targets = @(
        'aarch64-linux-android',
        'armv7-linux-androideabi',
        'i686-linux-android',
        'x86_64-linux-android'
    )
    foreach ($t in $targets) {
        & rustup target add $t 2>&1 | Out-Null
    }
    Write-Ok "Android Rust targets ready."
}

function Ensure-AppDeps {
    param([string]$Root)
    if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
        Write-Step "Installing JS dependencies (first run)..."
        Push-Location $Root
        try {
            & pnpm install
            if ($LASTEXITCODE -ne 0) { throw "pnpm install failed." }
        } finally {
            Pop-Location
        }
    } else {
        Write-Ok "node_modules present (skipping pnpm install)."
    }
}

# Run a pnpm script in the app root; propagate exit code.
function Invoke-Pnpm {
    param(
        [string]$Root,
        [Parameter(ValueFromRemainingArguments=$true)]
        [string[]]$Args
    )
    Push-Location $Root
    try {
        & pnpm @Args
        $code = $LASTEXITCODE
        if ($code -ne 0) { throw "pnpm $($Args -join ' ') failed (exit $code)." }
    } finally {
        Pop-Location
    }
}

# Sync the Android launcher icons into the generated Gradle project.
#
# `tauri android init` copies icons into gen/android only on first init; it
# never refreshes them afterwards. So when the source logo changes (or the gen
# project was created before the logo was set) the phone keeps showing the
# stale/default Tauri icon. This idempotent copy keeps the launcher icon in
# sync with src-tauri/icons/android on every dev/build run.
function Sync-AndroidLauncherIcons {
    param([string]$Root)
    $src = Join-Path $Root 'src-tauri\icons\android'
    $dst = Join-Path $Root 'src-tauri\gen\android\app\src\main\res'
    if (-not (Test-Path $src)) { return }          # no source icons — nothing to do
    if (-not (Test-Path $dst)) { return }          # gen/android not initialized yet
    Write-Step "Syncing Android launcher icons into gen/android"
    # Merge each mipmap-* folder's CONTENTS into the matching res/mipmap-* dir
    # (copying the folder itself risks nesting res/mipmap-hdpi/mipmap-hdpi).
    Get-ChildItem -Path $src -Directory -Filter 'mipmap-*' | ForEach-Object {
        $target = Join-Path $dst $_.Name
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        Copy-Item -Path (Join-Path $_.FullName '*') -Destination $target -Recurse -Force
    }
    # Adaptive-icon background colour (values/ic_launcher_background.xml).
    $bg = Join-Path $src 'values\ic_launcher_background.xml'
    if (Test-Path $bg) {
        $valuesDst = Join-Path $dst 'values'
        New-Item -ItemType Directory -Force -Path $valuesDst | Out-Null
        Copy-Item -Path $bg -Destination $valuesDst -Force
    }
    Write-Ok "Launcher icons synced."
}
