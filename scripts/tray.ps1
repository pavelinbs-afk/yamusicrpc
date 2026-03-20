param(
  [string]$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$LogDir = (Join-Path $PSScriptRoot '..\\logs'),
  [string]$NodeCmd = 'npm.cmd'
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logFile = Join-Path $LogDir 'discord-rpc.log'

function Write-Log([string]$msg) {
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  $line = "[$stamp] $msg"
  try {
    Add-Content -Path $logFile -Value $line
  } catch {}
}

$global:proc = $null
$global:installing = $false

function Stop-ProcessTreeById([int]$pid) {
  if (-not $pid) { return }
  # Убиваем процесс и детей.
  try {
    & taskkill /PID $pid /T /F | Out-Null
  } catch {}
}

function Stop-Rpc {
  try {
    if ($global:proc -and -not $global:proc.HasExited) {
      Write-Log "Stopping RPC pid=$($global:proc.Id)"
      Stop-ProcessTreeById $global:proc.Id
      Start-Sleep -Milliseconds 500
    }
  } catch {}
  $global:proc = $null
  try {
    if ($notifyIcon) {
      $notifyIcon.Text = 'Yandex Music RPC (остановлено)'
    }
  } catch {}
}

function Start-Node([ValidateSet('Hidden','Normal')] [string]$windowStyle) {
  # Остановим старое
  if ($global:proc -and -not $global:proc.HasExited) {
    Stop-ProcessTreeById $global:proc.Id
    Start-Sleep -Milliseconds 500
  }

  # Запускаем именно RPC (без повторного старта трей-контроллера).
  $args = @('run', 'rpc')
  $p = $null

  if ($windowStyle -eq 'Hidden') {
    $p = Start-Process `
      -FilePath $NodeCmd `
      -ArgumentList $args `
      -WorkingDirectory $ProjectDir `
      -WindowStyle Hidden `
      -PassThru `
      -RedirectStandardOutput $logFile `
      -RedirectStandardError $logFile
  } else {
    $p = Start-Process `
      -FilePath $NodeCmd `
      -ArgumentList $args `
      -WorkingDirectory $ProjectDir `
      -WindowStyle Normal `
      -PassThru
  }

  $global:proc = $p
  Write-Log "Started ($windowStyle). pid=$($p.Id)"
  try {
    if ($notifyIcon) {
      $notifyIcon.Text = "Yandex Music RPC (запущено, pid=$($p.Id))"
    }
  } catch {}
}

function Restart-Hidden {
  Write-Log "Restart requested"
  Start-Node -windowStyle Hidden
}

function Open-Console {
  Write-Log "Open console requested"
  Start-Node -windowStyle Normal
}

function Install-Dependencies {
  if ($global:installing) { return }
  $global:installing = $true

  Write-Log "npm install requested"

  # Запускаем установку в отдельном окне (чтобы было видно).
  # После завершения — перезапускаем скрыто.
  $p = Start-Process `
    -FilePath 'cmd.exe' `
    -ArgumentList "/c npm install" `
    -WorkingDirectory $ProjectDir `
    -WindowStyle Normal `
    -PassThru

  Register-ObjectEvent -InputObject $p -EventName Exited -Action {
    Write-Log "npm install finished (code=$($EventArgs.ExitCode))"
    $global:installing = $false
    try {
      Restart-Hidden
    } catch {
      Write-Log "Restart after install failed: $($_.Exception.Message)"
    }
  } | Out-Null
}

function Open-LogFolder {
  try {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $LogDir | Out-Null
  } catch {}
}

function Open-ProjectFolder {
  try {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $ProjectDir | Out-Null
  } catch {}
}

function Show-Toast([string]$title, [string]$text) {
  # Простая реализация через MessageBox (кросс-API нет в чистом PS).
  try {
    [System.Windows.Forms.MessageBox]::Show($text, $title) | Out-Null
  } catch {}
}

$context = New-Object System.Windows.Forms.ApplicationContext
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.Visible = $true
$notifyIcon.Text = 'Yandex Music RPC (запуск...)'

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miConsole = New-Object System.Windows.Forms.ToolStripMenuItem 'Открыть консоль'
$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem 'Перезапустить (npm run rpc)'
$miStop = New-Object System.Windows.Forms.ToolStripMenuItem 'Остановить RPC'
$miInstall = New-Object System.Windows.Forms.ToolStripMenuItem 'Переустановить зависимости (npm install)'
$miLog = New-Object System.Windows.Forms.ToolStripMenuItem 'Открыть папку с логами'
$miProj = New-Object System.Windows.Forms.ToolStripMenuItem 'Открыть папку проекта'
$miExit = New-Object System.Windows.Forms.ToolStripMenuItem 'Выход'

$miConsole.Add_Click({ Open-Console })
$miRestart.Add_Click({ Restart-Hidden })
$miStop.Add_Click({ Stop-Rpc })
$miInstall.Add_Click({ Install-Dependencies })
$miLog.Add_Click({ Open-LogFolder })
$miProj.Add_Click({ Open-ProjectFolder })
$miExit.Add_Click({
  try {
    Write-Log "Exit requested"
    Stop-Rpc
  } catch {}
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  $context.ExitThread()
})

$menu.Items.Add($miConsole) | Out-Null
$menu.Items.Add($miRestart) | Out-Null
$menu.Items.Add($miStop) | Out-Null
$menu.Items.Add($miInstall) | Out-Null
$menu.Items.Add($miLog) | Out-Null
$menu.Items.Add($miProj) | Out-Null
$menu.Items.Add('-') | Out-Null
$menu.Items.Add($miExit) | Out-Null

$notifyIcon.ContextMenuStrip = $menu

Write-Log "Tray started. ProjectDir=$ProjectDir"

# Запуск сразу в скрытом режиме
try {
  Restart-Hidden
} catch {
  Write-Log "Failed to start: $($_.Exception.Message)"
  Show-Toast 'Yandex Music RPC' 'Не удалось запустить. Проверьте логи.'
}

[System.Windows.Forms.Application]::Run($context)

