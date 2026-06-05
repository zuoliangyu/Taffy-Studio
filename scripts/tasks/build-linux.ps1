#Requires -Version 5.1
<#
.SYNOPSIS
  Build Linux release artifacts (deb + AppImage) via Docker.

.DESCRIPTION
  Runs the multi-stage build in docker/linux.Dockerfile, then extracts the
  bundle to ./dist-out/linux/. First build is ~10-15 min; later builds reuse
  Docker layer cache.

.PARAMETER NoCache
  Force a clean rebuild of the Docker image (ignore layer cache).
#>
[CmdletBinding()]
param(
    [switch]$NoCache
)

. "$PSScriptRoot\..\lib\common.ps1"

$root = Get-AppRoot

Write-Step "Preflight (Linux via Docker)"
Ensure-Docker

Push-Location $root
try {
    Write-Step "Building Docker image (linux)"
    $buildArgs = @('compose', 'build', 'linux')
    if ($NoCache) { $buildArgs += '--no-cache' }
    & docker @buildArgs
    if ($LASTEXITCODE -ne 0) { throw "docker compose build failed." }

    Write-Step "Extracting artifacts to dist-out/linux/"
    New-Item -ItemType Directory -Force -Path 'dist-out/linux' | Out-Null
    & docker compose run --rm linux
    if ($LASTEXITCODE -ne 0) { throw "docker compose run failed." }

    Write-Done "Linux artifacts:"
    Get-ChildItem -Recurse 'dist-out/linux' -Include *.deb, *.AppImage, *.rpm -ErrorAction SilentlyContinue |
        Select-Object FullName, @{N='Size';E={"{0:N1} MB" -f ($_.Length / 1MB)}} |
        Format-Table -AutoSize
}
finally {
    Pop-Location
}
