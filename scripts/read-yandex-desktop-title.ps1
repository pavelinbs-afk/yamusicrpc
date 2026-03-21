# Читает трек из заголовка окна десктопного клиента Яндекс.Музыки (Windows).
$ErrorActionPreference = 'SilentlyContinue'

# Не путать с окном этого приложения (Discord RPC): оно тоже «Yandex Music …» и раньше
# совпадало с шаблоном и подменяло собой настоящий плеер.
$candidates = Get-Process | Where-Object {
  $_.MainWindowHandle -ne [IntPtr]::Zero -and
  $_.MainWindowTitle -and
  $_.MainWindowTitle -notmatch '(?i)Yandex\s*Music\s*RPC' -and
  $_.MainWindowTitle -notmatch '(?i)Яндекс\s*Музыка\s*RPC' -and
  (
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

$t = [string]$proc.MainWindowTitle.Trim()
if ([string]::IsNullOrWhiteSpace($t)) {
  Write-Output '{"ok":false}'
  exit 0
}

# Всё до первого «|» — строка с треком (справа часто «Яндекс Музыка» и т.д.)
$parts = $t -split '\|', 2
$left = $parts[0].Trim()

if ([string]::IsNullOrWhiteSpace($left)) {
  Write-Output '{"ok":false}'
  exit 0
}

if ($left -match '^(Яндекс\s*Музыка|Yandex\s*Music|Yandex\s*Музыка)\s*$') {
  Write-Output '{"ok":false}'
  exit 0
}

$title = $null
$artist = $null

if ($left -match '^\s*(.+?)\s*[—–\-]\s*(.+?)\s*$') {
  $title = $matches[1].Trim()
  $artist = $matches[2].Trim()
} else {
  $title = $left
  $artist = ''
}

if (-not $title) {
  Write-Output '{"ok":false}'
  exit 0
}

[PSCustomObject]@{
  ok     = $true
  title  = $title
  artist = $artist
  source = 'desktop'
} | ConvertTo-Json -Compress
