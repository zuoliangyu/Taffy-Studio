#Requires -Version 5.1
<#
.SYNOPSIS
  Unified dev launcher for Taffy Studio (Windows host).

.DESCRIPTION
  Starts a dev session with hot-reload for the chosen target.
  Dev always runs on the local machine — Docker is not suitable for dev
  (no GUI, slower iteration). For desktop dev cross-compiled to Linux,
  use WSL2 with a real X server.

.PARAMETER Target
  desktop  -> tauri dev (Windows native window, hot-reload).        [default]
  android  -> tauri android dev (emulator or USB device).
  ios      -> errors out: iOS dev requires macOS + Xcode.
  help     -> show this help.

.EXAMPLE
  .\scripts\dev.ps1
  .\scripts\dev.ps1 android
#>
[CmdletBinding()]
param(
    [Parameter(Position=0)]
    [ValidateSet('desktop', 'android', 'ios', 'help')]
    [string]$Target = 'desktop'
)

. "$PSScriptRoot\lib\common.ps1"

if ($Target -eq 'help') {
    Get-Help $PSCommandPath -Detailed
    exit 0
}

$root = Get-AppRoot

Write-Step "Preflight"
Ensure-Node
Ensure-Pnpm
Ensure-Rust
Ensure-AppDeps $root

switch ($Target) {
    'desktop' {
        Write-Step "Starting desktop dev (tauri dev)"
        Write-Ok "First run compiles ~400 Rust crates and may take 5-10 min."
        Invoke-Pnpm -Root $root -Args @('tauri', 'dev')
    }

    'android' {
        Ensure-AndroidEnv
        Ensure-AndroidRustTargets

        # `tauri android dev` requires the gen/android project to exist.
        $genAndroid = Join-Path $root 'src-tauri\gen\android'
        if (-not (Test-Path $genAndroid)) {
            Write-Step "Initializing Android project (one-time)"
            Invoke-Pnpm -Root $root -Args @('tauri', 'android', 'init')
        }

        Write-Step "Starting Android dev"
        Write-Ok "Make sure either an emulator is running or a device is attached via USB (adb devices)."
        Invoke-Pnpm -Root $root -Args @('tauri', 'android', 'dev')
    }

    'ios' {
        throw @"
iOS dev requires macOS + Xcode. You cannot run it on Windows.

On a Mac:
  ./scripts/dev-mac.sh ios
"@
    }
}

Write-Done "dev session ended."
