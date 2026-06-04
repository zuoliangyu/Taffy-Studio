#Requires -Version 5.1
<#
.SYNOPSIS
  Build Android APK via Docker.

.DESCRIPTION
  Runs the multi-stage build in docker/android.Dockerfile, then extracts the
  APK to ./dist-android/. First build is heavy (~30 min, ~6 GB SDK+NDK
  download) — those layers cache and later builds are fast.

.PARAMETER NoCache
  Force a clean rebuild of the Docker image (ignore layer cache).
#>
[CmdletBinding()]
param(
    [switch]$NoCache
)

. "$PSScriptRoot\lib\common.ps1"

$root = Get-AppRoot

Write-Step "Preflight (Android via Docker)"
Ensure-Docker

Push-Location $root
try {
    Write-Step "Building Docker image (android) -- first run is slow"
    $buildArgs = @('compose', 'build', 'android')
    if ($NoCache) { $buildArgs += '--no-cache' }
    & docker @buildArgs
    if ($LASTEXITCODE -ne 0) { throw "docker compose build failed." }

    Write-Step "Extracting artifacts to dist-android/"
    New-Item -ItemType Directory -Force -Path 'dist-android' | Out-Null
    & docker compose run --rm android
    if ($LASTEXITCODE -ne 0) { throw "docker compose run failed." }

    Write-Done "Android artifacts:"
    Get-ChildItem -Recurse 'dist-android' -Include *.apk, *.aab -ErrorAction SilentlyContinue |
        Select-Object FullName, @{N='Size';E={"{0:N1} MB" -f ($_.Length / 1MB)}} |
        Format-Table -AutoSize
}
finally {
    Pop-Location
}
