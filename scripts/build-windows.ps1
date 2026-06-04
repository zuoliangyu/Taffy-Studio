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
#>
[CmdletBinding()]
param(
    [string]$Targets = 'nsis,msi'
)

. "$PSScriptRoot\lib\common.ps1"

$root = Get-AppRoot

Write-Step "Preflight (Windows build)"
Ensure-Node
Ensure-Pnpm
Ensure-Rust
Ensure-AppDeps $root

# MSVC Build Tools / WebView2 are checked indirectly: tauri build will fail with
# a clear message if they're missing. Surfacing them here would require Registry
# probing that's brittle across Win editions.

Write-Step "Building Windows installer ($Targets)"
Write-Ok "First run downloads sccache + compiles all Rust crates; subsequent builds reuse target/."
Invoke-Pnpm -Root $root -Args @('tauri', 'build', '--bundles', $Targets)

$bundleDir = Join-Path $root 'src-tauri\target\release\bundle'
Write-Done "Done. Artifacts:"
if (Test-Path $bundleDir) {
    Get-ChildItem -Recurse $bundleDir -Include *.exe, *.msi |
        Select-Object FullName, @{N='Size';E={"{0:N1} MB" -f ($_.Length / 1MB)}} |
        Format-Table -AutoSize
} else {
    Write-Warn "Bundle directory missing: $bundleDir"
}
