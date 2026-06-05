#Requires -Version 5.1
<#
.SYNOPSIS
  Unified dev launcher for Taffy Studio (Windows host). Interactive when run
  with no target.

.DESCRIPTION
  Starts a hot-reload dev session for the chosen target (dev is always a debug
  build). Run with NO argument for an interactive menu; pass a target to skip it.

    desktop  -> tauri dev (native window, hot-reload)        [default]
    android  -> tauri android dev (emulator or USB device)
    ios      -> errors out: iOS dev requires macOS + Xcode

.PARAMETER Target
  desktop | android | ios | help. Omit for the interactive menu.

.EXAMPLE
  .\scripts\dev.ps1
  .\scripts\dev.ps1 android
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Target
)

. "$PSScriptRoot\lib\common.ps1"

if ($Target -in @('help', '-h', '--help')) {
    Get-Help $PSCommandPath -Detailed
    exit 0
}

# Targets offered in the menu (ios is excluded - it can't run on a Windows host).
$menu = @(
    [ordered]@{ Key = 'desktop'; Desc = 'tauri dev - native window, hot-reload' }
    [ordered]@{ Key = 'android'; Desc = 'tauri android dev - emulator or USB device' }
)

if (-not $Target) {
    Write-Step "Taffy Studio - dev"
    $n = 0
    foreach ($t in $menu) { $n++; Write-Host ("  [{0}] {1,-9} {2}" -f $n, $t.Key, $t.Desc) }
    Write-Host ""
    $pick = Read-Host "Pick a target [1-$($menu.Count)] (blank to cancel)"
    if ([string]::IsNullOrWhiteSpace($pick)) { Write-Warn "Cancelled."; exit 0 }
    if ($pick -notmatch '^\d+$' -or [int]$pick -lt 1 -or [int]$pick -gt $menu.Count) { throw "Invalid choice: $pick" }
    $Target = $menu[[int]$pick - 1].Key
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

    default { throw "Unknown target '$Target'. Try: desktop | android | ios | help" }
}

Write-Done "dev session ended."
