# build/icon.ico — классический BMP/DIB (NSIS/WiX/rcedit не всегда корректно читают PNG внутри ICO).
# electron/icon.ico — ICO с вложенными PNG (Electron / unpacked — лучшее качество).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$buildDir = Join-Path $root 'build'
$electronDir = Join-Path $root 'electron'
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
New-Item -ItemType Directory -Force -Path $electronDir | Out-Null

Add-Type -AssemblyName System.Drawing

if (-not ('InstallerIcoEncoder' -as [type])) {
  Add-Type @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class InstallerIcoEncoder
{
  public static void Write(string path, Bitmap[] images)
  {
    if (images == null || images.Length == 0) throw new ArgumentException("images");
    var imageData = new List<byte[]>(images.Length);
    foreach (var bmp in images)
      imageData.Add(CreateIcoDib(bmp));

    int count = imageData.Count;
    int dirSize = 6 + 16 * count;
    int offset = dirSize;
    var lengths = new int[count];
    var offsets = new int[count];
    for (int i = 0; i < count; i++)
    {
      lengths[i] = imageData[i].Length;
      offsets[i] = offset;
      offset += lengths[i];
    }

    using (var fs = File.Create(path))
    using (var bw = new BinaryWriter(fs))
    {
      bw.Write((ushort)0);
      bw.Write((ushort)1);
      bw.Write((ushort)count);
      for (int i = 0; i < count; i++)
      {
        Bitmap bmp = images[i];
        int w = bmp.Width;
        int h = bmp.Height;
        byte wb = (byte)(w >= 256 ? 0 : Math.Min(255, w));
        byte hb = (byte)(h >= 256 ? 0 : Math.Min(255, h));
        bw.Write(wb);
        bw.Write(hb);
        bw.Write((byte)0);
        bw.Write((byte)0);
        bw.Write((ushort)1);
        bw.Write((ushort)32);
        bw.Write((uint)lengths[i]);
        bw.Write((uint)offsets[i]);
      }
      for (int i = 0; i < count; i++)
        bw.Write(imageData[i]);
    }
  }

  static byte[] CreateIcoDib(Bitmap bmp)
  {
    int w = bmp.Width;
    int h = bmp.Height;
    int xorSize = w * h * 4;
    int andRowBytes = ((w + 31) / 32) * 4;
    int andSize = andRowBytes * h;
    int biHeight = h * 2;

    BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try
    {
      int stride = data.Stride;
      int srcLen = Math.Abs(stride) * h;
      byte[] src = new byte[srcLen];
      Marshal.Copy(data.Scan0, src, 0, srcLen);

      var dib = new byte[40 + xorSize + andSize];
      WriteInt32(dib, 0, 40);
      WriteInt32(dib, 4, w);
      WriteInt32(dib, 8, biHeight);
      WriteInt16(dib, 12, 1);
      WriteInt16(dib, 14, 32);
      WriteInt32(dib, 16, 0);
      WriteInt32(dib, 20, xorSize + andSize);
      WriteInt32(dib, 24, 0);
      WriteInt32(dib, 28, 0);
      WriteInt32(dib, 32, 0);
      WriteInt32(dib, 36, 0);

      for (int y = 0; y < h; y++)
      {
        int srcRow = h - 1 - y;
        int srcOff = srcRow * stride;
        int dstOff = 40 + y * w * 4;
        Buffer.BlockCopy(src, srcOff, dib, dstOff, w * 4);
      }

      Array.Clear(dib, 40 + xorSize, andSize);
      return dib;
    }
    finally
    {
      bmp.UnlockBits(data);
    }
  }

  static void WriteInt32(byte[] b, int o, int v) { BitConverter.GetBytes(v).CopyTo(b, o); }
  static void WriteInt16(byte[] b, int o, short v) { BitConverter.GetBytes(v).CopyTo(b, o); }
}
'@ -ReferencedAssemblies System.Drawing
}

function Write-IcoEmbeddedPng {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][System.Collections.Generic.List[hashtable]]$Frames
  )
  $count = $Frames.Count
  $dirSize = 6 + (16 * $count)
  $offset = [uint32]$dirSize
  $fs = [System.IO.File]::Create($Path)
  $bw = New-Object System.IO.BinaryWriter($fs)
  try {
    $bw.Write([uint16]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]$count)
    foreach ($f in $Frames) {
      $w = [int]$f.W
      $h = [int]$f.H
      $png = [byte[]]$f.Png
      $len = $png.Length
      $wb = if ($w -eq 256) { [byte]0 } else { [byte]([Math]::Min(255, $w)) }
      $hb = if ($h -eq 256) { [byte]0 } else { [byte]([Math]::Min(255, $h)) }
      $bw.Write($wb)
      $bw.Write($hb)
      $bw.Write([byte]0)
      $bw.Write([byte]0)
      $bw.Write([uint16]1)
      $bw.Write([uint16]0)
      $bw.Write([uint32]$len)
      $bw.Write([uint32]$offset)
      $offset = [uint32]($offset + $len)
    }
    foreach ($f in $Frames) {
      $bw.Write([byte[]]$f.Png)
    }
  } finally {
    $bw.Dispose()
  }
}

$purple = [System.Drawing.Color]::FromArgb(255, 88, 101, 242)
$note = [string][char]0x266A
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = New-Object 'System.Collections.Generic.List[hashtable]'
$bitmaps = New-Object 'System.Collections.Generic.List[System.Drawing.Bitmap]'

foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.Clear($purple)
    $fontPx = [float]([Math]::Max(5.0, [Math]::Min(118.0, [Math]::Round($s * 0.46))))
    $font = [System.Drawing.Font]::new(
      'Segoe UI Symbol',
      $fontPx,
      [System.Drawing.FontStyle]::Regular,
      [System.Drawing.GraphicsUnit]::Pixel
    )
    $sf = $null
    try {
      $sf = New-Object System.Drawing.StringFormat
      $sf.Alignment = [System.Drawing.StringAlignment]::Center
      $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
      $rect = New-Object System.Drawing.RectangleF 0, 0, $s, $s
      $g.DrawString($note, $font, [System.Drawing.Brushes]::White, $rect, $sf)
    } finally {
      if ($font) { $font.Dispose() }
      if ($sf) { $sf.Dispose() }
    }
  } finally {
    $g.Dispose()
  }
  $ms = New-Object System.IO.MemoryStream
  try {
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $frames.Add(@{ W = $s; H = $s; Png = $ms.ToArray() })
  } finally {
    $ms.Dispose()
  }
  $bitmaps.Add($bmp)
}

try {
  Write-IcoEmbeddedPng -Path (Join-Path $electronDir 'icon.ico') -Frames $frames
  [InstallerIcoEncoder]::Write((Join-Path $buildDir 'icon.ico'), $bitmaps.ToArray())
} finally {
  foreach ($b in $bitmaps) {
    if ($b) { $b.Dispose() }
  }
}
