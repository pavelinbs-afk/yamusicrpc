$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
}
"@

$candidates = Get-Process | Where-Object {
  $_.MainWindowHandle -ne [IntPtr]::Zero -and
  $_.MainWindowTitle -and (
    $_.MainWindowTitle -match 'Яндекс\s*Музыка' -or
    $_.MainWindowTitle -match 'Yandex\s*Music' -or
    $_.MainWindowTitle -match 'Yandex\s*Музыка'
  )
}

if (-not $candidates) {
  Write-Output '{"ok":false}'
  exit 0
}

$proc = $candidates | Sort-Object { $_.MainWindowTitle.Length } -Descending | Select-Object -First 1

$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) {
  Write-Output '{"ok":false}'
  exit 0
}

$rect = New-Object Win32+RECT
if (-not [Win32]::GetWindowRect($hwnd, [ref]$rect)) {
  Write-Output '{"ok":false}'
  exit 0
}

[PSCustomObject]@{
  ok     = $true
  left   = [int]$rect.Left
  top    = [int]$rect.Top
  right  = [int]$rect.Right
  bottom = [int]$rect.Bottom
} | ConvertTo-Json -Compress
