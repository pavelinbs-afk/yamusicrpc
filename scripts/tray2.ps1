param(
  [string]$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$LogDir = (Join-Path $PSScriptRoot '..\\logs'),
  [string]$NodeCmd = 'node'
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Used to bring an existing console window to front (when available).
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Win32ShowWindow {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logFile = Join-Path $LogDir 'discord-rpc.log'
$errLogFile = Join-Path $LogDir 'discord-rpc.err.log'
$disableFlagFile = Join-Path $LogDir 'rpc.disabled'

# On a fresh app launch we want RPC to be able to start again.
# `rpc.disabled` can remain from a previous Stop/Exit session, which causes
# confusing "Discord RPC: запусти программу..." toasts when it skips startup.
try {
  if (Test-Path $disableFlagFile) {
    Remove-Item -Force $disableFlagFile -ErrorAction SilentlyContinue | Out-Null
    Write-Log "Startup: rpc.disabled removed to allow RPC start."
  }
} catch {}

function Write-Log([string]$msg) {
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  $line = "[$stamp] $msg"
  try {
    Add-Content -Path $logFile -Value $line -Encoding utf8
  } catch {}
}

$global:proc = $null
$global:installing = $false
$global:notifyIcon = $null
$global:exiting = $false
$global:nodeExe = $null

$lockFile = Join-Path $LogDir 'tray2.lock'
$global:lockHandle = $null

function Acquire-TrayLock {
  try {
    # If lock exists, check whether owning PID is still alive.
    if (Test-Path $lockFile) {
      $existingPidText = ''
      try { $existingPidText = (Get-Content -Path $lockFile -ErrorAction SilentlyContinue | Select-Object -First 1) } catch {}
      $existingPid = 0
      try { $existingPid = [int]($existingPidText) } catch { $existingPid = 0 }

      if ($existingPid -ne 0 -and $existingPid -ne $PID) {
        $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
        if ($null -ne $proc) {
          Write-Log "Tray lock exists (pid=$existingPid). Current tray will exit."
          return $false
        }
      }

      # Stale lock
      try { Remove-Item -Force $lockFile } catch {}
    }

    # Create lock exclusively (atomic).
    $fs = [System.IO.File]::Open($lockFile, 'CreateNew', 'ReadWrite', 'None')
    $global:lockHandle = $fs
    $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$PID)
    $fs.Write($bytes, 0, $bytes.Length)
    $fs.Flush()
    return $true
  } catch {
    return $false
  }
}

function Release-TrayLock {
  try {
    if ($global:lockHandle) {
      try { $global:lockHandle.Close() } catch {}
      $global:lockHandle = $null
    }
    if (Test-Path $lockFile) {
      Remove-Item -Force $lockFile | Out-Null
    }
  } catch {}
}

function Show-ConsoleWindow([int]$pid) {
  try {
    if (-not $pid -or $pid -eq $PID) { return $false }
    $p = Get-Process -Id $pid -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    # For console-hosted processes MainWindowHandle is sometimes 0.
    $hwnd = $p.MainWindowHandle
    if (-not $hwnd -or $hwnd -eq [IntPtr]::Zero -or $hwnd -eq 0) { return $false }
    [Win32ShowWindow]::ShowWindowAsync($hwnd, 5) | Out-Null
    [Win32ShowWindow]::SetForegroundWindow($hwnd) | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Cleanup-ExitLogs {
  param(
    [int]$KeepLatest = 15
  )
  try {
    $exitLogs = Get-ChildItem -Path $LogDir -File -Filter "discord-rpc_exit_*.log" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending
    if ($exitLogs -and $exitLogs.Count -gt $KeepLatest) {
      $toRemove = $exitLogs | Select-Object -Skip $KeepLatest
      foreach ($f in $toRemove) {
        try { Remove-Item -Force $f.FullName -ErrorAction SilentlyContinue } catch {}
      }
    }

    $exitErrLogs = Get-ChildItem -Path $LogDir -File -Filter "discord-rpc_exit_*.err.log" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending
    if ($exitErrLogs -and $exitErrLogs.Count -gt $KeepLatest) {
      $toRemove2 = $exitErrLogs | Select-Object -Skip $KeepLatest
      foreach ($f2 in $toRemove2) {
        try { Remove-Item -Force $f2.FullName -ErrorAction SilentlyContinue } catch {}
      }
    }

    # Also clean logs created by "Clear logs" action:
    $clearLogs = Get-ChildItem -Path $LogDir -File -Filter "discord-rpc_clear_*.log" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending
    if ($clearLogs -and $clearLogs.Count -gt $KeepLatest) {
      $toRemoveClear = $clearLogs | Select-Object -Skip $KeepLatest
      foreach ($fc in $toRemoveClear) {
        try { Remove-Item -Force $fc.FullName -ErrorAction SilentlyContinue } catch {}
      }
    }

    $clearErrLogs = Get-ChildItem -Path $LogDir -File -Filter "discord-rpc_clear_*.err.log" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending
    if ($clearErrLogs -and $clearErrLogs.Count -gt $KeepLatest) {
      $toRemoveClearErr = $clearErrLogs | Select-Object -Skip $KeepLatest
      foreach ($fce in $toRemoveClearErr) {
        try { Remove-Item -Force $fce.FullName -ErrorAction SilentlyContinue } catch {}
      }
    }

    # Also clean rotated logs created by `index.js` on startup:
    # `discord-rpc.log.utf8.bak.<timestamp>` and `discord-rpc.err.log.utf8.bak.<timestamp>`
    $bakLogs = Get-ChildItem -Path $LogDir -File -Filter "discord-rpc.log.utf8.bak.*" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending
    if ($bakLogs -and $bakLogs.Count -gt $KeepLatest) {
      $toRemove3 = $bakLogs | Select-Object -Skip $KeepLatest
      foreach ($f3 in $toRemove3) {
        try { Remove-Item -Force $f3.FullName -ErrorAction SilentlyContinue } catch {}
      }
    }

    $bakErrLogs = Get-ChildItem -Path $LogDir -File -Filter "discord-rpc.err.log.utf8.bak.*" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending
    if ($bakErrLogs -and $bakErrLogs.Count -gt $KeepLatest) {
      $toRemove4 = $bakErrLogs | Select-Object -Skip $KeepLatest
      foreach ($f4 in $toRemove4) {
        try { Remove-Item -Force $f4.FullName -ErrorAction SilentlyContinue } catch {}
      }
    }
  } catch {}
}

function Clear-DiscordLogs {
  param(
    # KeepLatestEffective означает: сколько самых свежих архивов/файлов оставлять.
    # `0` -> удалить всё.
    [int]$KeepLatest = 15,
    [bool]$ArchiveCurrent = $true
  )
  try {
    if ($ArchiveCurrent) {
      $ts = (Get-Date).ToString('yyyyMMdd_HHmmss')
      if (Test-Path $logFile) {
        $dst = [IO.Path]::Combine((Split-Path $logFile -Parent), ("discord-rpc_clear_$ts.log"))
        Move-Item -Force $logFile $dst
      }
      if (Test-Path $errLogFile) {
        $dst2 = [IO.Path]::Combine((Split-Path $errLogFile -Parent), ("discord-rpc_clear_$ts.err.log"))
        Move-Item -Force $errLogFile $dst2
      }
    } else {
      # Truncate without archiving (keep files for current writer).
      if (Test-Path $logFile) { Set-Content -Path $logFile -Value '' -Encoding UTF8 }
      if (Test-Path $errLogFile) { Set-Content -Path $errLogFile -Value '' -Encoding UTF8 }
    }
  } catch {}

  try { Cleanup-ExitLogs -KeepLatest $KeepLatest } catch {}
  try { Write-Log "Logs cleared (keepLatest=$KeepLatest, archiveCurrent=$ArchiveCurrent)" } catch {}
}

function Show-ClearLogsDialog {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "Clear Discord RPC logs"
  $form.Width = 380
  $form.Height = 220
  $form.StartPosition = "CenterScreen"
  # Make sure WinForms uses a reliable font for Cyrillic.
  $form.Font = [System.Drawing.SystemFonts]::MessageBoxFont
  $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Font
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false

  $lblKeep = New-Object System.Windows.Forms.Label
  $lblKeep.Text = "Keep archives above the newest one (0 = only last)"
  $lblKeep.Left = 15
  $lblKeep.Top = 18
  $lblKeep.Width = 320
  $form.Controls.Add($lblKeep)

  $numKeep = New-Object System.Windows.Forms.NumericUpDown
  $numKeep.Left = 15
  $numKeep.Top = 40
  $numKeep.Width = 120
  $numKeep.Minimum = 0
  $numKeep.Maximum = 200
  $numKeep.Value = 15
  $form.Controls.Add($numKeep)

  $chkArchive = New-Object System.Windows.Forms.CheckBox
  $chkArchive.Text = "Archive current logs before cleanup"
  $chkArchive.Left = 15
  $chkArchive.Top = 78
  $chkArchive.Width = 320
  $chkArchive.Checked = $true
  $form.Controls.Add($chkArchive)

  $btnClearKeep = New-Object System.Windows.Forms.Button
  $btnClearKeep.Text = "Clear (except last)"
  $btnClearKeep.Width = 140
  $btnClearKeep.Height = 28
  $btnClearKeep.Left = 15
  $btnClearKeep.Top = 135
  $btnClearKeep.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $form.Controls.Add($btnClearKeep)

  $btnClearAll = New-Object System.Windows.Forms.Button
  $btnClearAll.Text = "Clear all incl. last"
  $btnClearAll.Width = 170
  $btnClearAll.Height = 28
  $btnClearAll.Left = 145
  $btnClearAll.Top = 135
  $btnClearAll.DialogResult = [System.Windows.Forms.DialogResult]::Yes
  $form.Controls.Add($btnClearAll)

  $btnCancel = New-Object System.Windows.Forms.Button
  $btnCancel.Text = "Cancel"
  $btnCancel.Width = 90
  $btnCancel.Height = 28
  $btnCancel.Left = 160
  $btnCancel.Top = 165
  $btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.Controls.Add($btnCancel)

  $form.AcceptButton = $btnClearKeep
  $form.CancelButton = $btnCancel

  $res = $form.ShowDialog()
  if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
    # KeepLatestEffective = newest (1) + extra N (min 0 => leave only newest)
    $keepValExtra = [int]$numKeep.Value
    $effectiveKeep = $keepValExtra + 1
    $archiveVal = [bool]$chkArchive.Checked
    Clear-DiscordLogs -KeepLatest $effectiveKeep -ArchiveCurrent $archiveVal
  } elseif ($res -eq [System.Windows.Forms.DialogResult]::Yes) {
    # Remove everything including the newest one.
    Clear-DiscordLogs -KeepLatest 0 -ArchiveCurrent $false
  } else {
    return
  }
}

function Stop-TreeByPid([int]$targetPid) {
  if (-not $targetPid) { return }
  # Не даём скрипту убить сам себя.
  if ($targetPid -eq $PID) { return }
  try {
    taskkill /PID $targetPid /T /F | Out-Null
  } catch {}
}

function Invoke-DirectDiscordClear {
  try {
    if (-not $global:nodeExe) {
      $global:nodeExe = (Get-Command $NodeCmd -ErrorAction Stop).Source
    }
    $clearScript = Join-Path $ProjectDir 'scripts\clear-discord-activity.js'
    if (-not (Test-Path $clearScript)) { return }

    $p = Start-Process `
      -FilePath $global:nodeExe `
      -ArgumentList @($clearScript) `
      -WorkingDirectory $ProjectDir `
      -WindowStyle Hidden `
      -PassThru `
      -Wait
    Write-Log "Direct Discord clear exit code=$($p.ExitCode)"
  } catch {
    try { Write-Log "Direct Discord clear failed: $($_.Exception.Message)" } catch {}
  }
}

function Start-Rpc([ValidateSet('Hidden','Normal')] [string]$windowStyle) {
  if ($global:exiting) { return }
  if (Test-Path $disableFlagFile) {
    try { Write-Log "RPC start skipped: disabled flag present ($disableFlagFile)" } catch {}
    return
  }
  # Останавливаем старый RPC
  if ($global:proc -and -not $global:proc.HasExited) {
    Write-Log "Stopping old RPC pid=$($global:proc.Id)"
    Stop-TreeByPid $global:proc.Id
    Start-Sleep -Milliseconds 600
  }

  # Stop any existing listener on port 8765 to avoid multiple instances.
  try {
    $listeners = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
    if ($listeners) {
      $pids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
      foreach ($ownerPid in $pids) {
        Stop-TreeByPid $ownerPid
      }
    }
  } catch {}

  # Resolve node executable once.
  if (-not $global:nodeExe) {
    try {
      $global:nodeExe = (Get-Command $NodeCmd -ErrorAction Stop).Source
    } catch {
      try { Write-Log "Node executable not found: $NodeCmd" } catch {}
      return
    }
  }

  $rpcArgs = @('index.js')
  $p = $null

  if ($windowStyle -eq 'Hidden') {
    # Start via cmd.exe so a console window exists and can be brought back later.
    # chcp 65001 keeps console encoding consistent for any console output.
    # NOTE: quote only the node executable path, not the whole "node.exe index.js".
    $cmdArgs = "/c chcp 65001 > nul && `"$global:nodeExe`" index.js"
    $p = Start-Process `
      -FilePath 'cmd.exe' `
      -ArgumentList $cmdArgs `
      -WorkingDirectory $ProjectDir `
      -WindowStyle Hidden `
      -PassThru
  } else {
    # Console mode: visible standalone cmd with node index.js
    # NOTE: quote only the node executable path.
    $cmdArgs = "/k chcp 65001 > nul && `"$global:nodeExe`" index.js"
    $p = Start-Process `
      -FilePath 'cmd.exe' `
      -ArgumentList $cmdArgs `
      -WorkingDirectory $ProjectDir `
      -WindowStyle Normal `
      -PassThru
  }

  $global:proc = $p
  Write-Log "Started RPC ($windowStyle). pid=$($p.Id)"
  if ($global:notifyIcon) {
    $global:notifyIcon.Text = "Yandex Music RPC (running, pid=$($p.Id))"
  }
}

function Stop-Rpc([switch]$FromExit) {
  if ($FromExit) {
    $global:exiting = $true
  }
  try { Write-Log "Stop-Rpc clicked" } catch {}

  # Disables auto-start of RPC in any future tray instances.
  try {
    Set-Content -Path $disableFlagFile -Value ("disabled_at=" + (Get-Date).ToString('o')) -Encoding UTF8
  } catch {}

  # Ask server to clear+shutdown first (this is the main path to remove Discord status).
  $clearSent = $false
  try {
    $uri = "http://localhost:8765/track"
    $body = '{ "clear": true, "shutdown": true }'
    Invoke-RestMethod -Method Post -Uri $uri -ContentType "application/json" -Body $body | Out-Null
    Write-Log "Stop-Rpc: /track clear+shutdown POST OK"
    $clearSent = $true
  } catch {
    try { Write-Log "Stop-Rpc: /track clear+shutdown POST failed: $($_.Exception.Message)" } catch {}
  }

  # Fallback: force shutdown endpoint if clear+shutdown request could not be delivered.
  if (-not $clearSent) {
    try {
      $shutdownUri = "http://localhost:8765/shutdown"
      Invoke-RestMethod -Method Post -Uri $shutdownUri -ContentType "application/json" -Body '{}' | Out-Null
      Write-Log "Stop-Rpc: /shutdown POST OK"
    } catch {
      try { Write-Log "Stop-Rpc: /shutdown POST failed: $($_.Exception.Message)" } catch {}
    }
  }
  Start-Sleep -Milliseconds 700
  Invoke-DirectDiscordClear

  try {
  if ($global:proc -and -not $global:proc.HasExited) {
    Write-Log "Stopping RPC pid=$($global:proc.Id)"
      try { Stop-Process -Id $global:proc.Id -Force -ErrorAction SilentlyContinue } catch {}
      Stop-TreeByPid $global:proc.Id
      Start-Sleep -Milliseconds 600
    }
  } catch {
    # ignore
  }

  # Kill any listener that keeps port 8765 alive (authoritative source).
  try {
    for ($i=0; $i -lt 30; $i++) {
      $listeners = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
      if (-not $listeners) { break }
      $pids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
      foreach ($ownerPid in $pids) {
        if (-not $ownerPid -or $ownerPid -eq $PID) { continue }
        Write-Log "Stop-Rpc: killing owner pid=$ownerPid (attempt=$i)"
        try { Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue } catch {}
        Stop-TreeByPid $ownerPid
      }
      Start-Sleep -Milliseconds 250
    }
  } catch {
    try { Write-Log "Stop-Rpc: Get-NetTCPConnection failed: $($_.Exception.Message)" } catch {}
  }

  # Fallback for systems where Get-NetTCPConnection is unreliable.
  try {
    for ($i=0; $i -lt 20; $i++) {
      $lines = netstat -ano | Select-String "LISTENING" | Select-String ":8765"
      if (-not $lines) { break }
      foreach ($ln in $lines) {
        $parts = ($ln.ToString().Trim() -split '\s+')
        $pidTxt = $parts[$parts.Length - 1]
        if ($pidTxt -match '^\d+$') {
          $netPid = [int]$pidTxt
          if ($netPid -ne $PID) {
            Write-Log "Stop-Rpc: netstat fallback kill pid=$netPid (attempt=$i)"
            try { Stop-Process -Id $netPid -Force -ErrorAction SilentlyContinue } catch {}
            Stop-TreeByPid $netPid
          }
        }
      }
      Start-Sleep -Milliseconds 250
    }
  } catch {
    try { Write-Log "Stop-Rpc: netstat fallback failed: $($_.Exception.Message)" } catch {}
  }

  # Extra safety: force-kill remaining node.exe by commandline match.
  try {
    $procs = Get-CimInstance Win32_Process | Where-Object {
      $_.Name -eq 'node.exe' -and $_.CommandLine -like "*index.js*"
    }
    foreach ($pr in $procs) {
      if ($pr.ProcessId -eq $PID) { continue }
      try {
        Write-Log "Stop-Rpc: extra kill node pid=$($pr.ProcessId)"
        taskkill /PID $pr.ProcessId /T /F | Out-Null
      } catch {}
    }
  } catch {}

  # Проверяем, что порт 8765 реально закрыт, иначе добиваем ещё раз.
  try {
    for ($i=0; $i -lt 12; $i++) {
      Start-Sleep -Milliseconds 250
      $listeners2 = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
      if (-not $listeners2) { break }
      $pids2 = $listeners2 | Select-Object -ExpandProperty OwningProcess -Unique
      foreach ($pid2 in $pids2) {
        if ($pid2 -eq $PID) { continue }
        Stop-TreeByPid $pid2
      }
    }

    $listenersFinal = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
    if ($listenersFinal) {
      try { Write-Log "Stop-Rpc: port 8765 still listening after kills." } catch {}
    }
  } catch {}

  $global:proc = $null
  if ($global:notifyIcon) {
    $global:notifyIcon.Text = "Yandex Music RPC (stopped)"
  }
  try {
    $listenersFinal = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
    if ($listenersFinal) {
      Write-Log "Stop-Rpc: port 8765 STILL listening after Stop-Rpc"
    } else {
      Write-Log "Stop-Rpc: port 8765 closed"
    }
  } catch {}

  # After stopping node.exe, rotate main logs too.
  # This prevents `index.js` from creating lots of `.utf8.bak.*` files on next start.
  try {
    $ts = (Get-Date).ToString('yyyyMMdd_HHmmss')
    if (Test-Path $logFile) {
      $dst = [IO.Path]::Combine((Split-Path $logFile -Parent), ("discord-rpc_exit_$ts.log"))
      Move-Item -Force $logFile $dst
    }
    if (Test-Path $errLogFile) {
      $dst2 = [IO.Path]::Combine((Split-Path $errLogFile -Parent), ("discord-rpc_exit_$ts.err.log"))
      Move-Item -Force $errLogFile $dst2
    }
  } catch {}

  try { Cleanup-ExitLogs } catch {}
}

function Restart-Hidden {
  $global:exiting = $false
  # Пользовательский restart включает RPC обратно.
  try {
    if (Test-Path $disableFlagFile) { Remove-Item -Force $disableFlagFile | Out-Null }
  } catch {}
  Write-Log 'Restart requested'
  Start-Rpc -windowStyle Hidden
}

function Open-Console {
  $global:exiting = $false
  Write-Log 'Open console requested'
  # Пользовательский запуск включает RPC обратно.
  try {
    if (Test-Path $disableFlagFile) { Remove-Item -Force $disableFlagFile | Out-Null }
  } catch {}

  # If RPC is already running, try to bring its existing console window to front.
  try {
    if ($global:proc -and -not $global:proc.HasExited) {
      $ok = Show-ConsoleWindow -pid $global:proc.Id
      if ($ok) {
        try { Write-Log "Open console: shown existing pid=$($global:proc.Id)" } catch {}
        return
      }
    }
  } catch {}

  # Fallback: Резервный вариант: при отсутствии консоли запустить обычный консольный RPC.
  Start-Rpc -windowStyle Normal
}

function Install-Dependencies {
  if ($global:installing) { return }
  $global:installing = $true
  Write-Log 'pnpm install requested'

  $p = Start-Process `
    -FilePath 'cmd.exe' `
    -ArgumentList '/c pnpm install' `
    -WorkingDirectory $ProjectDir `
    -WindowStyle Normal `
    -PassThru

  Register-ObjectEvent -InputObject $p -EventName Exited -Action {
    Write-Log "pnpm install finished (code=$($EventArgs.ExitCode))"
    $global:installing = $false
    try { Restart-Hidden } catch { Write-Log "Restart after install failed: $($_.Exception.Message)" }
  } | Out-Null
}

function Open-Folder([string]$path) {
  try {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $path | Out-Null
  } catch {}
}

$context = New-Object System.Windows.Forms.ApplicationContext

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.Visible = $true
$notifyIcon.Text = 'Yandex Music RPC (starting...)'
$global:notifyIcon = $notifyIcon

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miConsole = New-Object System.Windows.Forms.ToolStripMenuItem "Open console"
$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem "Перезапустить RPC"
$miStop = New-Object System.Windows.Forms.ToolStripMenuItem "Stop RPC"
$miInstall = New-Object System.Windows.Forms.ToolStripMenuItem "Reinstall deps (pnpm)"
$miLog = New-Object System.Windows.Forms.ToolStripMenuItem "Open logs folder"
$miClearLogs = New-Object System.Windows.Forms.ToolStripMenuItem "Clear logs..."
$miProj = New-Object System.Windows.Forms.ToolStripMenuItem "Open project folder"
$miExit = New-Object System.Windows.Forms.ToolStripMenuItem "Exit"

$miConsole.Add_Click({ Open-Console })
$miRestart.Add_Click({ Restart-Hidden })
$miStop.Add_Click({ Stop-Rpc })
$miInstall.Add_Click({ Install-Dependencies })
$miLog.Add_Click({ Open-Folder $ProjectDir })
$miClearLogs.Add_Click({ try { Show-ClearLogsDialog } catch {} })
$miProj.Add_Click({ Open-Folder $ProjectDir })
$miExit.Add_Click({
  $global:exiting = $true
  try {
    $uri = "http://localhost:8765/track"
    $body = '{ "clear": true, "shutdown": true }'
    try { Write-Log "Exit: sending clear POST" } catch {}
    try {
      Invoke-RestMethod -Method Post -Uri $uri -ContentType "application/json" -Body $body | Out-Null
      try { Write-Log "Exit: clear POST OK" } catch {}
    } catch {
      throw
    }
  } catch {
    try { Write-Log "Exit clear request failed: $($_.Exception.Message)" } catch {}
  }

  # Даем серверу чуть времени применить clearActivity() в Discord.
  try { Start-Sleep -Milliseconds 800 } catch {}

  try { Stop-Rpc -FromExit } catch {}

  # Отключаем автозапуск RPC в новых tray-инстансах.
  try {
    Set-Content -Path $disableFlagFile -Value ("disabled_at=" + (Get-Date).ToString('o')) -Encoding UTF8
  } catch {}

  # Чистим логи
  try {
    # Чтобы можно было понять, почему статус возвращается,
    # не удаляем логи сразу. Архивируем с таймштампом.
    $ts = (Get-Date).ToString('yyyyMMdd_HHmmss')
    if (Test-Path $logFile) {
      $dst = [IO.Path]::Combine((Split-Path $logFile -Parent), ("discord-rpc_exit_$ts.log"))
      Move-Item -Force $logFile $dst
    }
    if (Test-Path $errLogFile) {
      $dst2 = [IO.Path]::Combine((Split-Path $errLogFile -Parent), ("discord-rpc_exit_$ts.err.log"))
      Move-Item -Force $errLogFile $dst2
    }
  } catch {}
  # Auto-clean old archived logs (keeps `logs\` size under control).
  try { Cleanup-ExitLogs } catch {}
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  try { Release-TrayLock } catch {}
  $context.ExitThread()
})

$menu.Items.Add($miConsole) | Out-Null
$menu.Items.Add($miRestart) | Out-Null
$menu.Items.Add($miStop) | Out-Null
$menu.Items.Add($miInstall) | Out-Null
$menu.Items.Add($miLog) | Out-Null
$menu.Items.Add($miClearLogs) | Out-Null
$menu.Items.Add($miProj) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$menu.Items.Add($miExit) | Out-Null

$notifyIcon.ContextMenuStrip = $menu

Write-Log "Tray2 started. ProjectDir=$ProjectDir"

if (-not (Acquire-TrayLock)) {
  try {
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
  } catch {}
  $context.ExitThread()
  return
}

try {
  Start-Rpc -windowStyle Hidden
} catch {
  Write-Log "Failed to start: $($_.Exception.Message)"
}

[System.Windows.Forms.Application]::Run($context)

