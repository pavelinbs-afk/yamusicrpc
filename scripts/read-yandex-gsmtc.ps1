# Метаданные + таймлайн (позиция/длительность) через GSMTC Windows.
$ErrorActionPreference = 'Stop'
try {
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
} catch {}

function Test-IsYandexMusicGsmtcId([string]$id) {
  if ([string]::IsNullOrWhiteSpace($id)) { return $false }
  if ($id -match '(?i)YandexBrowser') { return $false }
  if ($id -match '(?i)A025C540\.Yandex\.Music') { return $true }
  if ($id -match '(?i)Yandex\.Music') { return $true }
  if ($id -match '(?i)YandexMusic') { return $true }
  if ($id -match '(?i)Y\.Music\.exe|\\Y\.Music\.exe') { return $true }
  if ($id -match '(?i)yandex.*music|music.*yandex') { return $true }
  return $false
}

function Write-Fail {
  Write-Output '{"ok":false}'
  exit 0
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
} catch {
  Write-Fail
}

$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

if (-not $asTaskGeneric) {
  Write-Fail
}

function Await-WinRT {
  param($asyncOp, [Type]$resultType)
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $netTask = $asTask.Invoke($null, @($asyncOp))
  $null = $netTask.Wait(-1)
  return $netTask.Result
}

try {
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus, Windows.Media.Control, ContentType = WindowsRuntime]
} catch {
  Write-Fail
}

try {
  $mgrOp = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
  $manager = Await-WinRT $mgrOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
} catch {
  Write-Fail
}

$Playing = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing
$Paused = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Paused

function Get-MediaProps($session) {
  try {
    $pOp = $session.TryGetMediaPropertiesAsync()
    return Await-WinRT $pOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  } catch {
    return $null
  }
}

function Get-TimelineSeconds($session) {
  $posSec = $null
  $durSec = $null
  try {
    $tl = $session.GetTimelineProperties()
    $start = $tl.StartTime
    $end = $tl.EndTime
    $pos = $tl.Position
    $spanDur = $end - $start
    $spanPos = $pos - $start
    if ($spanDur.TotalSeconds -gt 0.5) {
      $durSec = [math]::Round([math]::Max(0, $spanDur.TotalSeconds), 3)
    }
    if ($durSec -and $spanPos.TotalSeconds -ge 0) {
      $posSec = [math]::Round([math]::Min([math]::Max(0, $spanPos.TotalSeconds), $durSec), 3)
    }
  } catch {}
  return @{ PositionSec = $posSec; DurationSec = $durSec }
}

function Save-ThumbnailToFile($props) {
  try {
    $thumb = $props.Thumbnail
    if (-not $thumb) { return $null }
    $streamOp = $thumb.OpenReadAsync()
    $AsTask_IRandomAccessStreamWithContentType = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    if (-not $AsTask_IRandomAccessStreamWithContentType) { return $null }
    $netTask = $AsTask_IRandomAccessStreamWithContentType.MakeGenericMethod([Windows.Storage.Streams.IRandomAccessStreamWithContentType]).Invoke($null, @($streamOp))
    $null = $netTask.Wait(-1)
    $stream = $netTask.Result
    if (-not $stream) { return $null }
    $size = $stream.Size
    if ($size -le 0 -or $size -gt 5242880) { try { $stream.Dispose() } catch {}; return $null }
    $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
    $loadOp = $reader.LoadAsync([uint32]$size)
    $AsTask_UInt32 = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    $netTask2 = $AsTask_UInt32.MakeGenericMethod([uint32]).Invoke($null, @($loadOp))
    $null = $netTask2.Wait(-1)
    $loaded = $netTask2.Result
    if ($loaded -ne $size) { try { $stream.Dispose() } catch {}; return $null }
    $bytes = [byte[]]::new($size)
    $reader.ReadBytes($bytes)
    $outPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'yandex-music-rpc-cover.png')
    [System.IO.File]::WriteAllBytes($outPath, $bytes)
    try { $reader.Dispose() } catch {}
    try { $stream.Dispose() } catch {}
    return $outPath
  } catch {
    return $null
  }
}

$entries = [System.Collections.ArrayList]@()

function Add-SessionEntry($session, [int]$baseRank) {
  if (-not $session) { return }
  $id = [string]$session.SourceAppUserModelId
  if (-not (Test-IsYandexMusicGsmtcId $id)) { return }
  try {
    $info = $session.GetPlaybackInfo()
    $st = $info.PlaybackStatus
  } catch {
    return
  }
  $props = Get-MediaProps $session
  if (-not $props) { return }
  $t = [string]$props.Title
  $a = [string]$props.Artist
  if ([string]::IsNullOrWhiteSpace($t) -and [string]::IsNullOrWhiteSpace($a)) { return }
  $r = $baseRank
  if ($st -eq $Playing) { $r += 100 }
  elseif ($st -eq $Paused) { $r += 50 }
  [void]$entries.Add([PSCustomObject]@{
      Rank    = $r
      Session = $session
      Props   = $props
      Paused  = ($st -eq $Paused)
    })
}

try {
  Add-SessionEntry $manager.GetCurrentSession() 10
} catch {}

try {
  foreach ($s in $manager.GetSessions()) {
    Add-SessionEntry $s 0
  }
} catch {}

if ($entries.Count -eq 0) {
  Write-Fail
}

$pick = $entries | Sort-Object { $_.Rank } -Descending | Select-Object -First 1
$props = $pick.Props
$time = Get-TimelineSeconds $pick.Session
$coverPath = Save-ThumbnailToFile $props

[PSCustomObject]@{
  ok           = $true
  title        = [string]$props.Title
  artist       = [string]$props.Artist
  album        = [string]$props.AlbumTitle
  positionSec  = $time.PositionSec
  durationSec  = $time.DurationSec
  paused       = [bool]$pick.Paused
  source       = 'desktop'
  coverPath    = if ($coverPath) { $coverPath } else { $null }
} | ConvertTo-Json -Compress
exit 0
