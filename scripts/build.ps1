#Requires -Version 5.1
<#
.SYNOPSIS
  Unified release builder for Taffy Studio (Windows host). Interactive when run
  with no target.

.DESCRIPTION
  Run with NO argument for an interactive menu (pick a target, then debug/release).
  Pass a target to skip the menu (CI / pnpm scripts).

  Targets:
    windows -> native NSIS + MSI + portable exe
    linux   -> Docker (.deb + .AppImage)         [release]
    android -> Docker (.apk, debug-signed)        [debug]
    web     -> single-file taffy-web binary
    all     -> windows + linux + web + android

  Build mode (-DebugBuild) applies to the native targets (windows, web). Docker
  linux is always release; Android is always debug (release needs a keystore).

.PARAMETER Target
  windows | linux | android | web | all | help. Omit for the interactive menu.

.PARAMETER DebugBuild
  Build an unoptimised debug build (larger, faster to compile). Default: release.

.EXAMPLE
  .\scripts\build.ps1                  # interactive
  .\scripts\build.ps1 windows          # release windows build
  .\scripts\build.ps1 windows -DebugBuild
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Target,
    [switch]$DebugBuild
)

. "$PSScriptRoot\lib\common.ps1"
$scriptsDir = $PSScriptRoot

# Key | Description | does the leaf script accept -DebugBuild?
$targets = @(
    [ordered]@{ Key = 'windows'; Desc = 'native NSIS + MSI installers + portable exe'; Debuggable = $true }
    [ordered]@{ Key = 'linux';   Desc = 'Docker -> .deb + .AppImage  (release)';        Debuggable = $false }
    [ordered]@{ Key = 'android'; Desc = 'Docker -> .apk  (debug-signed)';               Debuggable = $false }
    [ordered]@{ Key = 'web';     Desc = 'single-file taffy-web server binary';          Debuggable = $true }
    [ordered]@{ Key = 'all';     Desc = 'windows + linux + web + android';              Debuggable = $true }
)

if ($Target -in @('help', '-h', '--help')) {
    Get-Help $PSCommandPath -Detailed
    exit 0
}

# Interactive menu when no target was given.
if (-not $Target) {
    Write-Step "Taffy Studio - build"
    $n = 0
    foreach ($t in $targets) { $n++; Write-Host ("  [{0}] {1,-9} {2}" -f $n, $t.Key, $t.Desc) }
    Write-Host ""
    $pick = Read-Host "Pick a target [1-$($targets.Count)] (blank to cancel)"
    if ([string]::IsNullOrWhiteSpace($pick)) { Write-Warn "Cancelled."; exit 0 }
    if ($pick -notmatch '^\d+$' -or [int]$pick -lt 1 -or [int]$pick -gt $targets.Count) { throw "Invalid choice: $pick" }
    $Target = $targets[[int]$pick - 1].Key

    # Ask debug/release only when the selection has a debuggable native leaf.
    if (($targets | Where-Object { $_.Key -eq $Target }).Debuggable) {
        Write-Host ""
        Write-Host "  [1] release   optimised, smaller  (default)"
        Write-Host "  [2] debug     unoptimised, larger, faster to compile"
        $m = Read-Host "Build mode [1-2] (blank = release)"
        if ($m.Trim() -eq '2') { $DebugBuild = $true }
    }
}

$valid = @($targets | ForEach-Object { $_.Key })
if ($valid -notcontains $Target) { throw "Unknown target '$Target'. Try: $($valid -join ' | ') | help" }
$mode = if ($DebugBuild) { 'debug' } else { 'release' }

function Invoke-SubBuild {
    param([string]$Name, [string]$Script, [bool]$PassDebug)
    Write-Step "[$Name] $(Split-Path -Leaf $Script)$(if ($PassDebug -and $DebugBuild) { ' (debug)' })"
    if ($PassDebug -and $DebugBuild) { & $Script -DebugBuild }
    else { & $Script }
    if ($LASTEXITCODE -ne 0) { throw "[$Name] build failed (exit $LASTEXITCODE)." }
}

switch ($Target) {
    'windows' { Invoke-SubBuild 'windows' (Join-Path $scriptsDir 'build-windows.ps1') $true }
    'linux'   { Invoke-SubBuild 'linux'   (Join-Path $scriptsDir 'build-linux.ps1')   $false }
    'android' { Invoke-SubBuild 'android' (Join-Path $scriptsDir 'build-android.ps1') $false }
    'web'     { Invoke-SubBuild 'web'     (Join-Path $scriptsDir 'build-web.ps1')     $true }
    'all' {
        Invoke-SubBuild 'windows' (Join-Path $scriptsDir 'build-windows.ps1') $true
        Invoke-SubBuild 'linux'   (Join-Path $scriptsDir 'build-linux.ps1')   $false
        Invoke-SubBuild 'web'     (Join-Path $scriptsDir 'build-web.ps1')     $true
        Invoke-SubBuild 'android' (Join-Path $scriptsDir 'build-android.ps1') $false
    }
}

Write-Done "All requested builds finished ($mode for native targets)."
