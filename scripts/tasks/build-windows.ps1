#Requires -Version 5.1
<#
.SYNOPSIS
  Build Windows release artifacts on the local machine.

.DESCRIPTION
  Native Windows build (no Docker — your host IS Windows).
  Produces NSIS installer + MSI bundle by default.

.PARAMETER Targets
  Bundle targets passed to tauri build, e.g. nsis, msi, app.
  Default: nsis,msi.

.PARAMETER DebugBuild
  Build an unoptimised debug build (larger, faster to compile). Default: release.
#>
[CmdletBinding()]
param(
    [string]$Targets = 'nsis,msi',
    [switch]$DebugBuild
)

. "$PSScriptRoot\..\lib\common.ps1"

$root = Get-AppRoot

Write-Step "Preflight (Windows build)"
Ensure-Node
Ensure-Pnpm
Ensure-Rust
Ensure-AppDeps $root

# MSVC Build Tools / WebView2 are checked indirectly: tauri build will fail with
# a clear message if they're missing. Surfacing them here would require Registry
# probing that's brittle across Win editions.

$profileDir = if ($DebugBuild) { 'debug' } else { 'release' }
$tauriArgs = @('tauri', 'build', '--bundles', $Targets)
if ($DebugBuild) { $tauriArgs += '--debug' }

Write-Step "Building Windows installer ($Targets, $profileDir)"
Write-Ok "First run compiles all Rust crates from scratch (~10 min); later builds reuse ./target."
Invoke-Pnpm -Root $root -Args $tauriArgs

$bundleDir = Join-Path $root "target\$profileDir\bundle"
Write-Done "Installers:"
if (Test-Path $bundleDir) {
    Get-ChildItem -Recurse $bundleDir -Include *.exe, *.msi |
        Select-Object FullName, @{N='Size';E={"{0:N1} MB" -f ($_.Length / 1MB)}} |
        Format-Table -AutoSize
} else {
    Write-Warn "Bundle directory missing: $bundleDir"
}

# --- Portable build -------------------------------------------------------
# The raw app exe is self-contained (frontend assets are embedded; it uses the
# system WebView2), so it runs without installation. Copy it out to dist-out/.
$conf = Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$relDir = Join-Path $root "target\$profileDir"
$portableSrc = @("$($conf.productName).exe", 'taffy-studio.exe') |
    ForEach-Object { Join-Path $relDir $_ } |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if ($portableSrc) {
    $outDir = Join-Path $root 'dist-out\windows'
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $suffix = if ($DebugBuild) { '-debug' } else { '' }
    $name = ('{0}_{1}{2}_x64-portable.exe' -f ($conf.productName -replace '\s', '-'), $conf.version, $suffix)
    $portable = Join-Path $outDir $name
    Copy-Item $portableSrc $portable -Force
    Write-Done "Portable (no install needed):"
    Write-Host ("    {0}  ({1:N1} MB)" -f $portable, ((Get-Item $portable).Length / 1MB))
    Write-Ok "Note: needs the WebView2 runtime (built into Win11; Win10 may need it installed once)."
} else {
    Write-Warn "Portable exe not found under target\release (looked for '$($conf.productName).exe' / 'taffy-studio.exe')."
}
