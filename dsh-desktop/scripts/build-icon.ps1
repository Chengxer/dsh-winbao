# Generates build/icon.png and assets/icon.png (512x512) with System.Drawing.
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root 'build'
$assetsDir = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $buildDir, $assetsDir | Out-Null

$size = 512
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

# Rounded-square gradient background.
$r = 96
$d = $r * 2
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()

$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point($size, $size)),
  [System.Drawing.Color]::FromArgb(255, 0x5B, 0x8C, 0xFF),
  [System.Drawing.Color]::FromArgb(255, 0x1B, 0x2A, 0x6B))
$g.FillPath($bg, $path)

# Soft top highlight.
$hl = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point(0, $size)),
  [System.Drawing.Color]::FromArgb(70, 255, 255, 255),
  [System.Drawing.Color]::FromArgb(0, 255, 255, 255))
$g.FillEllipse($hl, -120, -230, $size + 240, 430)

# Text.
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$fontMain = New-Object System.Drawing.Font('Segoe UI', 168, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fontSub = New-Object System.Drawing.Font('Segoe UI', 44, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('DSH', $fontMain, $white, (New-Object System.Drawing.RectangleF(0, 60, $size, 300)), $sf)
$g.DrawString('Desktop', $fontSub, $white, (New-Object System.Drawing.RectangleF(0, 330, $size, 140)), $sf)

$icon = Join-Path $buildDir 'icon.png'
$bmp.Save($icon, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Save((Join-Path $assetsDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "icon saved: $icon"

$fontMain.Dispose(); $fontSub.Dispose(); $white.Dispose(); $sf.Dispose()
$hl.Dispose(); $bg.Dispose(); $path.Dispose(); $g.Dispose(); $bmp.Dispose()
