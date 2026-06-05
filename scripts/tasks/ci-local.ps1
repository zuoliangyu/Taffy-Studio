#Requires -Version 5.1
<#
.SYNOPSIS
  Run the same checks as GitHub Actions CI, inside Docker.

.DESCRIPTION
  Verifies typecheck + vite build + cargo fmt + clippy + cargo check
  against the current working tree. First run builds the CI image
  (~5-10 min, ~1.5 GB). Subsequent runs reuse cached node_modules and
  cargo registry via named volumes, so they're fast (~2-3 min).

.PARAMETER NoCache
  Force a clean rebuild of the CI image.

.PARAMETER Reset
  Wipe the cached named volumes (node_modules, cargo registry, target).
  Use this if cached state gets weird (e.g. lockfile changes broke deps).

.EXAMPLE
  .\scripts\tasks\ci-local.ps1
  .\scripts\tasks\ci-local.ps1 -Reset
#>
[CmdletBinding()]
param(
    [switch]$NoCache,
    [switch]$Reset
)

. "$PSScriptRoot\..\lib\common.ps1"

$root = Get-AppRoot

Write-Step "Preflight"
Ensure-Docker

Push-Location $root
try {
    if ($Reset) {
        Write-Step "Wiping CI named volumes"
        & docker compose down -v ci 2>&1 | Out-Null
        & docker volume rm app_ci-cargo app_ci-cargo-git app_ci-target app_ci-node-modules 2>&1 | Out-Null
        Write-Ok "Volumes removed."
    }

    Write-Step "Building CI image (first run ~5-10 min)"
    $buildArgs = @('compose', 'build', 'ci')
    if ($NoCache) { $buildArgs += '--no-cache' }
    & docker @buildArgs
    if ($LASTEXITCODE -ne 0) { throw "docker compose build ci failed." }

    Write-Step "Running CI checks (mirrors .github/workflows/ci.yml)"
    & docker compose run --rm ci
    $exit = $LASTEXITCODE
    if ($exit -ne 0) {
        throw "Local CI failed with exit $exit. Fix the failures above before pushing."
    }

    Write-Done "Local CI passed. Safe to push."
}
finally {
    Pop-Location
}
