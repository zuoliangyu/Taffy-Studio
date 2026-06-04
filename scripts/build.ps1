#Requires -Version 5.1
<#
.SYNOPSIS
  Unified release builder for Taffy Studio (Windows host).

.DESCRIPTION
  Dispatches to the right build flow per target:
    windows -> native (fastest, you're already on Win11).
    linux   -> Docker (Ubuntu image with webkit2gtk + Rust + Node).
    android -> Docker (Ubuntu image with Android SDK + NDK).
    all     -> windows + linux + android, in that order.

  macOS / iOS cannot be built on a Windows host: Apple EULA forbids virtualizing
  macOS on non-Apple hardware. Use a real Mac and run scripts/build-mac.sh.

.PARAMETER Target
  windows | linux | android | all | help. Default: windows.

.EXAMPLE
  .\scripts\build.ps1
  .\scripts\build.ps1 all
#>
[CmdletBinding()]
param(
    [Parameter(Position=0)]
    [ValidateSet('windows', 'linux', 'android', 'all', 'help')]
    [string]$Target = 'windows'
)

. "$PSScriptRoot\lib\common.ps1"

if ($Target -eq 'help') {
    Get-Help $PSCommandPath -Detailed
    exit 0
}

function Invoke-SubBuild([string]$Name, [string]$Script) {
    Write-Step "[$Name] $Script"
    & $Script
    if ($LASTEXITCODE -ne 0) {
        throw "[$Name] build failed (exit $LASTEXITCODE)."
    }
}

$scriptsDir = $PSScriptRoot

switch ($Target) {
    'windows' { Invoke-SubBuild 'windows' (Join-Path $scriptsDir 'build-windows.ps1') }
    'linux'   { Invoke-SubBuild 'linux'   (Join-Path $scriptsDir 'build-linux.ps1') }
    'android' { Invoke-SubBuild 'android' (Join-Path $scriptsDir 'build-android.ps1') }
    'all' {
        Invoke-SubBuild 'windows' (Join-Path $scriptsDir 'build-windows.ps1')
        Invoke-SubBuild 'linux'   (Join-Path $scriptsDir 'build-linux.ps1')
        Invoke-SubBuild 'android' (Join-Path $scriptsDir 'build-android.ps1')
    }
}

Write-Done "All requested builds finished."
