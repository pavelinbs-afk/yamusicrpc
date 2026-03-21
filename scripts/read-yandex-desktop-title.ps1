# Читает трек из заголовка окна десктопного клиента Яндекс.Музыки (Windows).
$ErrorActionPreference = 'SilentlyContinue'
# Чтобы Node.js читал stdout как UTF-8 без кракозябр в кириллице.
try {
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
} catch {}

# Не путать с окном этого приложения (Discord RPC): оно тоже «Yandex Music …» и раньше
# совпадало с шаблоном и подменяло собой настоящий плеер.
#
# Важно: широкое совпадение «Yandex Music» ловит заголовки вкладок (GitHub и т.д.), где эти слова
# есть в описании, но это не плеер. Для браузеров требуем явный бренд плеера; для десктопного exe —
# определяем по имени/пути процесса (Store-приложение часто Y.Music.exe, не YandexMusic.exe).

function Test-IsYandexMusicDesktopProcess {
  param([System.Diagnostics.Process]$P)
  $n = $P.ProcessName
  if ($n -match '(?i)^(YandexMusic|YandexMusicDesktop|Y\.Music|Yandex\.Music)$') { return $true }
  if ($n -match '(?i)YandexMusic') { return $true }
  if ($n -match '(?i)^Yandex\s*Music$') { return $true }
  # Установщик с локализованным именем: «Яндекс Музыка.exe» → ProcessName «Яндекс Музыка»
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
  param(
    [System.Diagnostics.Process]$P
  )
  $t = [string]$P.MainWindowTitle
  if ([string]::IsNullOrWhiteSpace($t)) { return $false }
  if ($t -match '(?i)Yandex\s*Music\s*RPC' -or $t -match '(?i)Яндекс\s*Музыка\s*RPC') { return $false }

  # Десктопный клиент: в заголовке часто только «Исполнитель — Трек» без слов «Яндекс Музыка»
  if (Test-IsYandexMusicDesktopProcess $P) {
    return $true
  }

  # Браузер: только явный заголовок вкладки плеера (бренд справа от «|» или кириллица «Яндекс Музыка»)
  if ($t -notmatch 'Яндекс\s*Музыка' -and $t -notmatch 'Yandex\s*Музыка' -and $t -notmatch '(?i)\|\s*Yandex\s*Music') {
    return $false
  }

  return $true
}

$candidates = Get-Process | Where-Object {
  $_.MainWindowHandle -ne [IntPtr]::Zero -and
  $_.MainWindowTitle -and
  (Test-YandexMusicWindow $_)
}

if (-not $candidates) {
  Write-Output '{"ok":false}'
  exit 0
}

# Сначала окно десктопного приложения (Y.Music / YandexMusic / …), затем по длине заголовка
$proc = $candidates |
  Sort-Object @{ Expression = { if (Test-IsYandexMusicDesktopProcess $_) { 0 } else { 1 } } },
  @{ Expression = { $_.MainWindowTitle.Length }; Descending = $true } |
  Select-Object -First 1

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

# Клиент Яндекс.Музыки для Windows в заголовке: «Исполнитель — Название трека» (не наоборот).
$title = $null
$artist = $null

if ($left -match '^\s*(.+?)\s*[—–\-]\s*(.+?)\s*$') {
  $artist = $matches[1].Trim()
  $title = $matches[2].Trim()
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
