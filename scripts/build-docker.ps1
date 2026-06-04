#Requires -Version 5.1
<#
.SYNOPSIS
  Build (and optionally push) the Taffy Studio web-server Docker image.
.DESCRIPTION
  Builds docker/web.Dockerfile — a self-contained server image that serves the
  web UI in the browser. Unlike dev-docker.ps1 (build + run for local testing),
  this only produces/publishes the image.
.EXAMPLE
  .\scripts\build-docker.ps1
  .\scripts\build-docker.ps1 -Tag ghcr.io/you/taffy-web:0.1.0 -Push
  .\scripts\build-docker.ps1 -NoCache
#>
[CmdletBinding()]
param(
  [string]$Tag = 'taffy-web:latest',
  [switch]$Push,
  [switch]$NoCache
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$buildArgs = @('build', '-f', 'docker/web.Dockerfile', '-t', $Tag)
if ($NoCache) { $buildArgs += '--no-cache' }
$buildArgs += '.'

Write-Host "==> Building $Tag ..." -ForegroundColor Cyan
docker @buildArgs
if ($LASTEXITCODE -ne 0) { throw 'docker build failed' }

if ($Push) {
  Write-Host "==> Pushing $Tag ..." -ForegroundColor Cyan
  docker push $Tag
  if ($LASTEXITCODE -ne 0) { throw 'docker push failed' }
}

Write-Host "==> Done: $Tag" -ForegroundColor Green
