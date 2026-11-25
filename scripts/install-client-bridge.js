#!/usr/bin/env node
'use strict';

/**
 * Мост RPC → Яндекс.Музыка через CDP (Chrome DevTools Protocol).
 *
 * YM 5.128+: правка app.asar / flip Electron fuses ломает music-application://desktop
 * (ERR_FAILED −2, бесконечный relaunch). Поэтому:
 *  1) снимаем старый asar+fuses патч если был;
 *  2) ставим ярлык/launcher с --remote-debugging-port=9229;
 *  3) RPC читает плеер через CDP и шлёт source=client на /track.
 *
 * Usage:
 *   node scripts/install-client-bridge.js
 *   node scripts/install-client-bridge.js --uninstall
 *   node scripts/install-client-bridge.js --status
 *   node scripts/install-client-bridge.js --launch-if-needed
 */

const fs = (() => {
  try {
    return require('original-fs');
  } catch (_) {
    return require('fs');
  }
})();
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CDP_PORT = 9229;
const BAK_ASAR = '.bak-ymrpc';
const BAK_EXE = '.bak-ymrpc';
const FUSES_MARK = '.ymrpc-fuses';
const MARKER_FILE = '.ymrpc-cdp-bridge';

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function candidateAsarPaths() {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || '';
  const pf86 = process.env['ProgramFiles(x86)'] || '';
  const home = os.homedir();
  const bases = uniq([
    local && path.join(local, 'Programs', 'YandexMusic'),
    local && path.join(local, 'Programs', 'Yandex Music'),
    local && path.join(local, 'Programs', 'Яндекс Музыка'),
    local && path.join(local, 'YandexMusic'),
    pf && path.join(pf, 'YandexMusic'),
    pf86 && path.join(pf86, 'YandexMusic'),
    path.join(home, 'AppData', 'Local', 'Programs', 'YandexMusic'),
  ]);
  const out = [];
  for (const b of bases) {
    out.push(path.join(b, 'resources', 'app.asar'));
    out.push(path.join(b, 'app.asar'));
  }
  return out;
}

function resolveAsarPath(explicit) {
  if (explicit) {
    const p = path.resolve(explicit);
    if (fs.existsSync(p)) return p;
    throw new Error('app.asar не найден: ' + explicit);
  }
  for (const p of candidateAsarPaths()) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Не найден app.asar Яндекс.Музыки');
}

function findYandexExe(asarPath) {
  const dir = path.dirname(path.dirname(asarPath));
  const names = ['Яндекс Музыка.exe', 'YandexMusic.exe', 'Y.Music.exe', 'Yandex Music.exe'];
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  try {
    const hit = fs.readdirSync(dir).find(
      (n) => /\.exe$/i.test(n) && !/uninstall|elevate|update/i.test(n),
    );
    return hit ? path.join(dir, hit) : null;
  } catch (_) {
    return null;
  }
}

function rpcConfigDir() {
  return process.env.APPDATA
    ? path.join(process.env.APPDATA, 'yandex-music-rpc')
    : path.join(os.homedir(), 'yandex-music-rpc');
}

function launcherCmdPath() {
  return path.join(rpcConfigDir(), 'Launch Yandex Music (RPC bridge).cmd');
}

function launcherPs1Path() {
  return path.join(rpcConfigDir(), 'Launch Yandex Music (RPC bridge).ps1');
}

function markerPath() {
  return path.join(rpcConfigDir(), MARKER_FILE);
}

/** PowerShell -EncodedCommand (UTF-16LE) — кириллические пути не ломаются. */
function runPowerShellEncoded(script, timeoutMs = 20000) {
  const b64 = Buffer.from(String(script), 'utf16le').toString('base64');
  return spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
  );
}

function sleepMs(ms) {
  spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${Number(ms) || 0})`], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

function forceCloseYandexMusic() {
  if (process.platform !== 'win32') return { killed: 0 };
  const r = spawnSync(
    'taskkill',
    ['/F', '/IM', 'Яндекс Музыка.exe', '/T'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 },
  );
  sleepMs(1500);
  return { killed: r.status === 0 ? 1 : 0 };
}

/** Снять старый asar+fuses патч (если остался от прошлых версий). */
function restoreLegacyAsarPatch(asarPath) {
  const restored = { asar: false, exe: false };
  const bakAsar = asarPath + BAK_ASAR;
  const exePath = findYandexExe(asarPath);
  if (fs.existsSync(bakAsar) && fs.existsSync(asarPath)) {
    try {
      const asar = require('@electron/asar');
      let patched = false;
      try {
        const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
        patched = !!(pkg && (pkg.main === './ym-rpc-bootstrap.js' || pkg.__ymRpcOriginalMain));
      } catch (_) {}
      if (patched || fs.existsSync((exePath || '') + FUSES_MARK)) {
        forceCloseYandexMusic();
        fs.copyFileSync(bakAsar, asarPath);
        restored.asar = true;
      }
    } catch (_) {}
  }
  if (exePath && fs.existsSync(exePath + BAK_EXE)) {
    try {
      forceCloseYandexMusic();
      fs.copyFileSync(exePath + BAK_EXE, exePath);
      try { fs.unlinkSync(exePath + FUSES_MARK); } catch (_) {}
      restored.exe = true;
    } catch (_) {}
  }
  return restored;
}

function desktopShortcutPath() {
  return path.join(os.homedir(), 'Desktop', 'Яндекс Музыка (RPC).lnk');
}

/** Есть ли уже процесс клиента (не наш RPC). */
function isYandexMusicExeRunning() {
  if (process.platform !== 'win32') return false;
  const ps =
    "$ErrorActionPreference='SilentlyContinue'; " +
    "$p = Get-CimInstance Win32_Process | Where-Object { " +
    "$_.Name -eq 'Y.Music.exe' -or $_.Name -eq 'YandexMusic.exe' -or $_.Name -eq 'Яндекс Музыка.exe' -or " +
    "($_.ExecutablePath -and ($_.ExecutablePath -match '[\\\\/]YandexMusic[\\\\/]') -and ($_.ExecutablePath -notmatch 'discord-rpc|Yandex Music RPC')) " +
    '} | Select-Object -First 1 -ExpandProperty ProcessId; if ($p) { Write-Output $p }';
  const r = runPowerShellEncoded(ps, 8000);
  return !!(r.stdout || '').trim();
}

/** CDP уже слушает — повторный запуск не нужен. */
function isCdpPortOpen() {
  if (process.platform !== 'win32') return false;
  const ps =
    `$ErrorActionPreference='SilentlyContinue'; ` +
    `try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 "http://127.0.0.1:${CDP_PORT}/json/version"; if ($r.StatusCode -eq 200) { '1' } } catch {}`;
  const r = runPowerShellEncoded(ps, 4000);
  return (r.stdout || '').trim() === '1';
}

/**
 * Запуск клиента с --remote-debugging-port (как ярлык «Яндекс Музыка (RPC)»).
 * Кириллический путь — только через PowerShell EncodedCommand.
 */
function launchYandexMusic(exePath) {
  if (!exePath || !fs.existsSync(exePath)) return false;
  const exeLit = String(exePath).replace(/'/g, "''");
  const dirLit = path.dirname(exePath).replace(/'/g, "''");
  const ps =
    "$ErrorActionPreference='Stop'; " +
    `Start-Process -FilePath '${exeLit}' -WorkingDirectory '${dirLit}' ` +
    `-ArgumentList '--remote-debugging-port=${CDP_PORT}'`;
  const r = runPowerShellEncoded(ps, 20000);
  return r.status === 0;
}

/** Запустить YM с CDP, если ещё не запущена и порт свободен. */
function launchYandexMusicIfNeeded(asarPath) {
  if (process.platform !== 'win32') {
    return { ok: false, launchedYandexMusic: false, error: 'not_windows' };
  }
  if (isCdpPortOpen()) {
    return { ok: true, launchedYandexMusic: false, alreadyRunning: true, cdpOpen: true };
  }
  if (isYandexMusicExeRunning()) {
    return { ok: true, launchedYandexMusic: false, alreadyRunning: true, cdpOpen: false };
  }
  let exePath = asarPath ? findYandexExe(asarPath) : null;
  if (!exePath) {
    try {
      const marker = markerPath();
      if (fs.existsSync(marker)) {
        const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
        if (meta && meta.exePath && fs.existsSync(meta.exePath)) exePath = meta.exePath;
      }
    } catch (_) {}
  }
  if (!exePath) {
    return { ok: false, launchedYandexMusic: false, error: 'exe_not_found' };
  }
  // Обновить ярлык, если пропал.
  try {
    if (!fs.existsSync(desktopShortcutPath())) createDesktopShortcut(exePath);
  } catch (_) {}
  const launched = launchYandexMusic(exePath);
  return {
    ok: launched,
    launchedYandexMusic: launched,
    exePath,
    cdpPort: CDP_PORT,
    error: launched ? undefined : 'launch_failed',
  };
}

function writeLauncher(exePath) {
  const dir = rpcConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const ps1Path = launcherPs1Path();
  const cmdPath = launcherCmdPath();
  // .ps1 с BOM — кириллический путь exe не ломается.
  const ps1 =
    '$ErrorActionPreference = \'Stop\'\r\n' +
    `$exe = '${String(exePath).replace(/'/g, "''")}'\r\n` +
    `$wd = '${path.dirname(exePath).replace(/'/g, "''")}'\r\n` +
    `Start-Process -FilePath $exe -WorkingDirectory $wd -ArgumentList '--remote-debugging-port=${CDP_PORT}'\r\n`;
  fs.writeFileSync(ps1Path, '\uFEFF' + ps1, 'utf8');
  // .cmd без кириллицы — только вызов powershell -File (имя ps1 ASCII).
  const cmd =
    '@echo off\r\n' +
    'REM Yandex Music RPC CDP launcher (no Cyrillic in this file)\r\n' +
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Launch Yandex Music (RPC bridge).ps1"\r\n';
  fs.writeFileSync(cmdPath, cmd, 'ascii');
  fs.writeFileSync(
    markerPath(),
    JSON.stringify(
      {
        mode: 'cdp',
        port: CDP_PORT,
        exePath,
        launcher: cmdPath,
        launcherPs1: ps1Path,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
  return cmdPath;
}

/** Ярлык сразу на exe + аргумент порта — без .cmd (иначе cmd ломает UTF-8 кириллицу). */
function createDesktopShortcut(exePath) {
  if (process.platform !== 'win32') return null;
  const lnk = desktopShortcutPath();
  const ps =
    `$ws = New-Object -ComObject WScript.Shell\n` +
    `$s = $ws.CreateShortcut('${lnk.replace(/'/g, "''")}')\n` +
    `$s.TargetPath = '${String(exePath).replace(/'/g, "''")}'\n` +
    `$s.Arguments = '--remote-debugging-port=${CDP_PORT}'\n` +
    `$s.WorkingDirectory = '${path.dirname(exePath).replace(/'/g, "''")}'\n` +
    `$s.IconLocation = '${String(exePath).replace(/'/g, "''")},0'\n` +
    `$s.Description = 'Yandex Music + Discord RPC (CDP)'\n` +
    `$s.Save()\n` +
    `Write-Output 'ok'`;
  const r = runPowerShellEncoded(ps, 20000);
  if (r.status !== 0) {
    try {
      console.error('shortcut stderr:', (r.stderr || r.stdout || '').slice(0, 400));
    } catch (_) {}
    return null;
  }
  return lnk;
}

function install(asarPath) {
  const exePath = findYandexExe(asarPath);
  if (!exePath) throw new Error('Не найден exe Яндекс.Музыки');

  const legacy = restoreLegacyAsarPatch(asarPath);
  const launcher = writeLauncher(exePath);
  const shortcut = createDesktopShortcut(exePath);

  return {
    ok: true,
    installed: true,
    mode: 'cdp',
    cdpPort: CDP_PORT,
    asarPath,
    exePath,
    launcher,
    shortcut,
    legacyRestored: legacy,
    message:
      'Мост CDP установлен. Запускайте Яндекс.Музыку через ярлык «Яндекс Музыка (RPC)» ' +
      `на рабочем столе (порт ${CDP_PORT}). Обычный ярлык клиента — без моста.`,
  };
}

function uninstall(asarPath) {
  const legacy = restoreLegacyAsarPatch(asarPath);
  const removed = [];
  for (const p of [launcherCmdPath(), launcherPs1Path(), markerPath()]) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        removed.push(p);
      }
    } catch (_) {}
  }
  const desk = desktopShortcutPath();
  try {
    if (fs.existsSync(desk)) {
      fs.unlinkSync(desk);
      removed.push(desk);
    }
  } catch (_) {}
  return {
    ok: true,
    installed: false,
    mode: 'cdp',
    removed,
    legacyRestored: legacy,
  };
}

function status(asarPath) {
  const exePath = asarPath ? findYandexExe(asarPath) : null;
  const marker = markerPath();
  const launcher = launcherCmdPath();
  let meta = null;
  try {
    if (fs.existsSync(marker)) meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch (_) {}
  const installed = !!(meta && meta.mode === 'cdp' && fs.existsSync(launcher));

  // legacy asar still patched?
  let legacyPatched = false;
  try {
    if (asarPath && fs.existsSync(asarPath)) {
      const asar = require('@electron/asar');
      const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
      legacyPatched = pkg.main === './ym-rpc-bootstrap.js';
    }
  } catch (_) {}

  return {
    ok: true,
    asarPath: asarPath || null,
    exePath,
    installed,
    mode: installed ? 'cdp' : legacyPatched ? 'asar+fuses-legacy' : 'none',
    cdpPort: CDP_PORT,
    launcher: installed ? launcher : null,
    marker: installed ? marker : null,
    legacyPatched,
    packageMain: null,
  };
}

function parseArgs(argv) {
  const out = { uninstall: false, status: false, launch: false, asar: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--uninstall') out.uninstall = true;
    else if (a === '--status') out.status = true;
    else if (a === '--launch' || a === '--launch-if-needed') out.launch = true;
    else if (a === '--asar' && argv[i + 1]) out.asar = argv[++i];
    else if (a.startsWith('--asar=')) out.asar = a.slice('--asar='.length);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let asarPath = null;
  try {
    asarPath = resolveAsarPath(args.asar);
  } catch (e) {
    if (args.status) {
      console.log(JSON.stringify({ ok: false, installed: false, error: String(e.message || e) }, null, 2));
      return;
    }
    if (args.launch) {
      // exe можно взять из маркера без asar
      const res = launchYandexMusicIfNeeded(null);
      console.log(JSON.stringify(res, null, 2));
      process.exit(res.ok || res.alreadyRunning ? 0 : 1);
      return;
    }
    throw e;
  }

  console.error('asar:', asarPath);
  let result;
  if (args.status) result = status(asarPath);
  else if (args.launch) result = launchYandexMusicIfNeeded(asarPath);
  else if (args.uninstall) result = uninstall(asarPath);
  else result = install(asarPath);

  console.log(JSON.stringify(result, null, 2));
  if (!args.status && !args.launch) {
    console.error(result.message || (result.installed ? 'Готово.' : 'Снято.'));
  }
  if (args.launch && !(result.ok || result.alreadyRunning)) process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(String(e && e.stack ? e.stack : e));
    console.log(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
    process.exit(1);
  });
}

module.exports = {
  install,
  uninstall,
  status,
  CDP_PORT,
  launcherCmdPath,
  launcherPs1Path,
  desktopShortcutPath,
  launchYandexMusic,
  launchYandexMusicIfNeeded,
  restoreLegacyAsarPatch,
};
