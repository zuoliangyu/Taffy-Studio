#Requires -Version 5.1
<#
.SYNOPSIS
  Generate platform icons for Tauri.

.DESCRIPTION
  If you pass a master PNG, that's used directly. Otherwise a 1024x1024
  placeholder is drawn (solid background + 2 letters) so dev/build can run
  out-of-the-box. `tauri icon` then produces all platform variants:
  32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico,
  Square*Logo.png (Win Store), Android mipmaps, iOS AppIcon set.

.PARAMETER InputPath
  Existing master PNG (>=1024x1024 recommended).

.PARAMETER Letters
  Letters drawn on the placeholder (max 2-3 work well).

.PARAMETER Color
  Background color, "R,G,B" decimal.

.EXAMPLE
  .\scripts\tasks\gen-icons.ps1
  .\scripts\tasks\gen-icons.ps1 -InputPath C:\art\logo-1024.png
  .\scripts\tasks\gen-icons.ps1 -Letters "AI" -Color "30,30,40"
#>
[CmdletBinding()]
param(
    [string]$InputPath = '',
    [string]$Letters = 'FC',
    [string]$Color = '79,140,255'
)

. "$PSScriptRoot\..\lib\common.ps1"

$root = Get-AppRoot
$iconsDir = Join-Path $root 'src-tauri\icons'
New-Item -ItemType Directory -Force -Path $iconsDir | Out-Null

if (-not $InputPath) {
    Write-Step "Drawing placeholder master.png ('$Letters', bg $Color)"

    Add-Type -AssemblyName System.Drawing
    $rgb = $Color -split ',' | ForEach-Object { [int]$_.Trim() }
    if ($rgb.Count -ne 3) { throw "Color must be R,G,B (got '$Color')." }

    $size = 1024
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $bg = [System.Drawing.Color]::FromArgb($rgb[0], $rgb[1], $rgb[2])
        $g.Clear($bg)

        # Pick a font size that fits 2-3 letters comfortably.
        $fontSize = [Math]::Max(180, 480 - 70 * $Letters.Length)
        $font = New-Object System.Drawing.Font 'Segoe UI', $fontSize, ([System.Drawing.FontStyle]::Bold)
        $sf = New-Object System.Drawing.StringFormat
        $sf.Alignment = [System.Drawing.StringAlignment]::Center
        $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
        $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
        $g.DrawString($Letters, $font, [System.Drawing.Brushes]::White, $rect, $sf)
        $font.Dispose()
    } finally {
        $g.Dispose()
    }

    $InputPath = Join-Path $iconsDir 'master.png'
    $bmp.Save($InputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Ok "Wrote $InputPath"
} else {
    if (-not (Test-Path $InputPath)) { throw "Input not found: $InputPath" }
    $InputPath = (Resolve-Path $InputPath).Path
    Write-Ok "Using master image: $InputPath"
}

Write-Step "Generating platform icons (tauri icon)"
Push-Location $root
try {
    & pnpm tauri icon $InputPath
    if ($LASTEXITCODE -ne 0) { throw "tauri icon failed (exit $LASTEXITCODE)." }
} finally {
    Pop-Location
}

Write-Done "Icons under $iconsDir"
Get-ChildItem $iconsDir -File | Select-Object Name, @{N='KB';E={'{0:N0}' -f ($_.Length/1KB)}} | Format-Table -AutoSize
