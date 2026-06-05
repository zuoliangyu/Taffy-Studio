#Requires -Version 5.1
<#
.SYNOPSIS
  Interactively delete Taffy Studio build artifacts / caches to reclaim disk.
.DESCRIPTION
  Lists each cleanable item with its current size; you pick which to remove by
  number. Nothing is deleted without an explicit selection and confirmation.
.PARAMETER All
  Pre-select every present item (you still confirm unless -Yes).
.PARAMETER Yes
  Skip the final confirmation (combine with -All for non-interactive cleaning).
.EXAMPLE
  .\scripts\clean.ps1
  .\scripts\clean.ps1 -All
  .\scripts\clean.ps1 -All -Yes
#>
[CmdletBinding()]
param([switch]$All, [switch]$Yes)

. "$PSScriptRoot\lib\common.ps1"
$root = Get-AppRoot

# Name | Note | one-or-more relative paths
$items = @(
    [ordered]@{ Name = 'Windows / macOS installers'; Note = '.exe .msi .app .dmg (inside target/)';     Paths = @('target/release/bundle') }
    [ordered]@{ Name = 'Linux packages';             Note = '.deb .AppImage .rpm';                       Paths = @('dist-out/linux') }
    [ordered]@{ Name = 'Android packages';           Note = '.apk .aab';                                 Paths = @('dist-out/android') }
    [ordered]@{ Name = 'Web binary';                 Note = 'taffy-web[.exe]';                           Paths = @('dist-out/web') }
    [ordered]@{ Name = 'iOS packages';               Note = '.ipa';                                      Paths = @('dist-out/ios') }
    [ordered]@{ Name = 'ALL packaged output';        Note = 'the whole dist-out/ folder';                Paths = @('dist-out') }
    [ordered]@{ Name = 'Rust build cache';           Note = 'HUGE; next build recompiles from scratch';  Paths = @('target', 'src-tauri/target') }
    [ordered]@{ Name = 'Frontend build';             Note = 'vite output; pnpm build regenerates';       Paths = @('dist') }
    [ordered]@{ Name = 'TypeScript build info';      Note = 'incremental tsc cache';                     Paths = @('tsconfig.tsbuildinfo', 'tsconfig.node.tsbuildinfo') }
    [ordered]@{ Name = 'Generated mobile projects';  Note = 'src-tauri/gen; tauri *:init regenerates';   Paths = @('src-tauri/gen') }
    [ordered]@{ Name = 'node_modules';               Note = 'pnpm install refetches';                    Paths = @('node_modules') }
    [ordered]@{ Name = 'pnpm store cache';           Note = 'local pnpm content store';                  Paths = @('.pnpm-store') }
)

function Format-Size([long]$b) {
    if ($b -ge 1GB) { '{0:N1} GB' -f ($b / 1GB) }
    elseif ($b -ge 1MB) { '{0:N0} MB' -f ($b / 1MB) }
    elseif ($b -gt 0) { '{0:N0} KB' -f ($b / 1KB) }
    else { '-' }
}
function Get-PathSize([string[]]$paths) {
    $sum = 0L
    foreach ($p in $paths) {
        $full = Join-Path $root $p
        if (Test-Path -LiteralPath $full) {
            $m = Get-ChildItem -LiteralPath $full -Recurse -Force -File -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum
            if ($m.Sum) { $sum += [long]$m.Sum }
        }
    }
    return $sum
}
function Test-AnyPath([string[]]$paths) {
    foreach ($p in $paths) { if (Test-Path -LiteralPath (Join-Path $root $p)) { return $true } }
    return $false
}

Write-Step "Taffy Studio - clean build artifacts"
Write-Ok "Scanning sizes (the Rust cache may take a few seconds)..."
Write-Host ""

$rows = @()
$n = 0
foreach ($it in $items) {
    $n++
    $exists = Test-AnyPath $it.Paths
    $size = if ($exists) { Get-PathSize $it.Paths } else { 0 }
    $rows += [pscustomobject]@{ Index = $n; Name = $it.Name; Note = $it.Note; Paths = $it.Paths; Exists = $exists; Size = $size }
}

foreach ($r in $rows) {
    if ($r.Exists) { $tag = '{0,8}' -f (Format-Size $r.Size); $color = 'Gray' }
    else { $tag = ' (none)'; $color = 'DarkGray' }
    Write-Host ("  [{0,2}] {1,-28} {2}   " -f $r.Index, $r.Name, $tag) -ForegroundColor $color -NoNewline
    Write-Host $r.Note -ForegroundColor DarkGray
}
Write-Host ""

$selectable = @($rows | Where-Object { $_.Exists })
if ($selectable.Count -eq 0) { Write-Done "Nothing to clean - all clear."; return }

if ($All) {
    $chosen = $selectable
}
else {
    $ans = Read-Host "Enter numbers to delete (e.g. 2,3,7), 'all', or blank to cancel"
    if ([string]::IsNullOrWhiteSpace($ans)) { Write-Warn "Cancelled."; return }
    if ($ans.Trim().ToLower() -eq 'all') {
        $chosen = $selectable
    }
    else {
        $nums = $ans -split '[,\s]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }
        $chosen = @($rows | Where-Object { $_.Exists -and ($nums -contains $_.Index) })
        if ($chosen.Count -eq 0) { Write-Warn "No valid present items selected. Cancelled."; return }
    }
}

$total = ($chosen | Measure-Object -Property Size -Sum).Sum
Write-Host ""
Write-Step ("Will delete {0} item(s), freeing ~{1}:" -f $chosen.Count, (Format-Size $total))
foreach ($r in $chosen) { Write-Host ("  - {0}  ({1})" -f $r.Name, (Format-Size $r.Size)) -ForegroundColor Yellow }
Write-Host ""

if (-not $Yes) {
    $confirm = Read-Host "Proceed? type 'y' to delete"
    if ($confirm.Trim().ToLower() -ne 'y') { Write-Warn "Cancelled - nothing deleted."; return }
}

$rootResolved = (Resolve-Path -LiteralPath $root).Path
foreach ($r in $chosen) {
    foreach ($p in $r.Paths) {
        $full = Join-Path $root $p
        if (-not (Test-Path -LiteralPath $full)) { continue }
        # Safety: never delete anything outside the repo root.
        $resolved = (Resolve-Path -LiteralPath $full).Path
        if (-not $resolved.StartsWith($rootResolved)) { Write-Warn "Skipping out-of-root path: $resolved"; continue }
        Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
        Write-Ok "removed $p"
    }
}
Write-Done ("Done. Freed ~{0}." -f (Format-Size $total))
