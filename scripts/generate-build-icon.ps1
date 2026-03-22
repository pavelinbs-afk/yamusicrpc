# Иконка для NSIS/MSI (build/icon.ico). Запуск: pnpm run icon
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$buildDir = Join-Path $root 'build'
$icoPath = Join-Path $buildDir 'icon.ico'
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
if (Test-Path $icoPath) { exit 0 }

Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(255, 88, 101, 242))
$g.Dispose()
$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
try {
  $fs = [System.IO.File]::Create($icoPath)
  try {
    $icon.Save($fs)
  } finally {
    $fs.Dispose()
  }
} finally {
  $icon.Dispose()
  $bmp.Dispose()
}
