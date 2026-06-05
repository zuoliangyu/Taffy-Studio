#Requires -Version 5.1
<#
.SYNOPSIS
  Build + run the taffy-web (self-hosted web) image locally for testing.
.DESCRIPTION
  Builds docker/web.Dockerfile into taffy-web:dev and runs it, mapping a port
  and a named volume for the SQLite data. Provider API keys present in your
  shell environment are forwarded into the container; the server injects them
  into LLM requests (the browser never sees them).
.EXAMPLE
  .\scripts\tasks\dev-docker.ps1
  .\scripts\tasks\dev-docker.ps1 -Port 9000 -Token secret
  .\scripts\tasks\dev-docker.ps1 -NoCache
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [string]$Token = $env:TAFFY_TOKEN,
  [switch]$NoCache
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

# Always build. Docker's layer cache makes this near-instant when nothing
# changed and only rebuilds what actually changed — so you always get the
# latest code without remembering a -Rebuild flag. Use -NoCache to force a
# full clean rebuild.
$img = 'taffy-web:dev'
$buildArgs = @('build', '-f', 'docker/web.Dockerfile', '-t', $img)
if ($NoCache) { $buildArgs += '--no-cache' }
$buildArgs += '.'
Write-Host "==> Building $img ..." -ForegroundColor Cyan
docker @buildArgs
if ($LASTEXITCODE -ne 0) { throw 'docker build failed' }

# Forward provider keys + token that are set on the host.
$runArgs = @('run', '--rm', '-it', '-p', "${Port}:8787", '-v', 'taffy-web-data:/data')
foreach ($k in 'TAFFY_API_KEY', 'TAFFY_OPENAI_API_KEY', 'TAFFY_ANTHROPIC_API_KEY', 'TAFFY_GEMINI_API_KEY') {
  $v = [Environment]::GetEnvironmentVariable($k)
  if ($v) { $runArgs += @('-e', "$k=$v") }
}
if ($Token) { $runArgs += @('-e', "TAFFY_TOKEN=$Token") }
$runArgs += $img

Write-Host "==> Running on http://localhost:$Port  (Ctrl+C to stop)" -ForegroundColor Green
docker @runArgs
