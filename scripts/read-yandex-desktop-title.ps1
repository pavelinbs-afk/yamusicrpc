# Читает трек из десктопного клиента Яндекс.Музыки (Windows).
# Сначала MainWindowTitle; если пустой/не парсится — все видимые заголовки HWND того же процесса
# (у Electron/UWP трек часто не попадает в «главный» заголовок, но есть у другого окна).
$ErrorActionPreference = 'SilentlyContinue'
try {
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
} catch {}

$script:YmHasEnumWindows = $false
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class YmEnumWindows {
  private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumProc lpEnumCallback, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder strText, int maxCount);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hWnd);

  public static List<string> GetVisibleTitlesForPid(int pid) {
    var result = new List<string>();
    EnumWindows((hWnd, lParam) => {
      uint wpid;
      GetWindowThreadProcessId(hWnd, out wpid);
      if ((int)wpid != pid || !IsWindowVisible(hWnd)) return true;
      var sb = new StringBuilder(4096);
      int n = GetWindowText(hWnd, sb, 4096);
      if (n > 0) {
        string s = sb.ToString().Trim();
        if (s.Length > 0) result.Add(s);
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@ -ErrorAction SilentlyContinue
  $script:YmHasEnumWindows = $true
} catch {
  $script:YmHasEnumWindows = $false
}

function Test-IsYandexMusicDesktopProcess {
  param([System.Diagnostics.Process]$P)
  $n = $P.ProcessName
  if ($n -match '(?i)^(YandexMusic|YandexMusicDesktop|Y\.Music|Yandex\.Music)$') { return $true }
  if ($n -match '(?i)YandexMusic') { return $true }
  if ($n -match '(?i)^Yandex\s*Music$') { return $true }
  if ($n -match '^Яндекс\s*Музыка$') { return $true }
  try {
    $fp = $P.MainModule.FileName
    if ($fp -match 'Яндекс\s*Музыка') { return $true }
    if ($fp -match '(?i)YandexMusic|Yandex\.Music|Y\.Music|Yandex\\\\Music|WindowsApps\\\\.*Yandex.*Music') {
      return $true
    }
  } catch {}
  return $false
}

function Test-YandexMusicWindow {
  param([System.Diagnostics.Process]$P)
  if ($P.MainWindowTitle -match '(?i)Yandex\s*Music\s*RPC' -or $P.MainWindowTitle -match '(?i)Яндекс\s*Музыка\s*RPC') {
    return $false
  }
  if (Test-IsYandexMusicDesktopProcess $P) {
    return $true
  }
  $t = [string]$P.MainWindowTitle
  if ([string]::IsNullOrWhiteSpace($t)) { return $false }
  if ($t -notmatch 'Яндекс\s*Музыка' -and $t -notmatch 'Yandex\s*Музыка' -and $t -notmatch '(?i)\|\s*Yandex\s*Music') {
    return $false
  }
  return $true
}

function Split-TitleBarSegments([string]$s) {
  $pat = '\s*[\u2013\u2014\u2015\u2011\u2212\uFE58\uFE63\uFF0D\-]\s*'
  return @([regex]::Split(($s -replace '^\s+|\s+$', ''), $pat) | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Test-NoiseTitleSegment([string]$seg) {
  $s = $seg.Trim()
  if ($s.Length -eq 0) { return $true }
  if ($s -match '(?i)^Яндекс[.\s\u00A0]*Музыка$') { return $true }
  if ($s -match '(?i)^Yandex\s*Music$') { return $true }
  if ($s -match '(?i)собираем\s+музыку') { return $true }
  if ($s -match '(?i)музыку\s+для\s+вас') { return $true }
  if ($s -match '(?i)^Яндекс\.Музыка$') { return $true }
  return $false
}

function Test-IsRpcAppTitle([string]$t) {
  $s = $t.Trim()
  return ($s -match '(?i)Yandex\s*Music\s*RPC$' -or $s -match '(?i)Яндекс\s*Музыка\s*RPC$')
}

function Try-ParseTrackFromWindowText([string]$rawFull) {
  $t = $rawFull.Trim()
  if ([string]::IsNullOrWhiteSpace($t)) { return $null }
  if (Test-IsRpcAppTitle $t) { return $null }

  $parts = $t -split '\|', 2
  $left = $parts[0].Trim()
  if ([string]::IsNullOrWhiteSpace($left)) { return $null }
  if ($left -match '^(Яндекс\s*Музыка|Yandex\s*Music|Yandex\s*Музыка)\s*$') { return $null }

  $segments = [System.Collections.ArrayList]@()
  foreach ($x in (Split-TitleBarSegments $left)) { [void]$segments.Add($x) }

  while ($segments.Count -gt 0 -and (Test-NoiseTitleSegment ([string]$segments[0]))) {
    $segments.RemoveAt(0)
  }
  while ($segments.Count -gt 0 -and (Test-NoiseTitleSegment ([string]$segments[$segments.Count - 1]))) {
    $segments.RemoveAt($segments.Count - 1)
  }

  if ($segments.Count -eq 0) { return $null }

  $title = $null
  $artist = $null
  if ($segments.Count -ge 2) {
    $artist = [string]$segments[0]
    $rest = @($segments[1..($segments.Count - 1)])
    $title = ($rest -join ' — ')
  } else {
    $artist = ''
    $title = [string]$segments[0]
  }

  if ($segments.Count -eq 1 -and $title.Length -lt 3) { return $null }
  if ((Test-NoiseTitleSegment $title) -or ($artist -and (Test-NoiseTitleSegment $artist))) { return $null }
  if (-not $title) { return $null }

  return [PSCustomObject]@{ title = $title; artist = $artist }
}

$candidates = Get-Process | Where-Object {
  $_.MainWindowHandle -ne [IntPtr]::Zero -and (
    (Test-IsYandexMusicDesktopProcess $_) -or
    ($_.MainWindowTitle -and (Test-YandexMusicWindow $_))
  )
}

if (-not $candidates) {
  Write-Output '{"ok":false}'
  exit 0
}

$ordered = $candidates |
  Sort-Object @{ Expression = { if (Test-IsYandexMusicDesktopProcess $_) { 0 } else { 1 } } },
  @{ Expression = { $_.MainWindowTitle.Length }; Descending = $true }

$titleCandidates = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($proc in $ordered) {
  $mw = [string]$proc.MainWindowTitle.Trim()
  if ($mw) { [void]$titleCandidates.Add($mw) }

  if ($script:YmHasEnumWindows -and (Test-IsYandexMusicDesktopProcess $proc)) {
    try {
      foreach ($w in [YmEnumWindows]::GetVisibleTitlesForPid($proc.Id)) {
        $x = $w.Trim()
        if ($x) { [void]$titleCandidates.Add($x) }
      }
    } catch {}
  }
}

$sortedTexts = @($titleCandidates) | Sort-Object { $_.Length } -Descending

foreach ($raw in $sortedTexts) {
  $parsed = Try-ParseTrackFromWindowText $raw
  if ($null -ne $parsed) {
    [PSCustomObject]@{
      ok     = $true
      title  = $parsed.title
      artist = $parsed.artist
      source = 'desktop'
    } | ConvertTo-Json -Compress
    exit 0
  }
}

Write-Output '{"ok":false}'
exit 0
