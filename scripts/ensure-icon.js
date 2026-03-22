'use strict';

/**
 * После git clone нет build/icon.ico — создаём для dev (electron .) без ручного pnpm run icon.
 * Полная перегенерация: pnpm run icon
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') return;

const root = path.join(__dirname, '..');
const electronIco = path.join(root, 'electron', 'icon.ico');
const buildIco = path.join(root, 'build', 'icon.ico');
if (fs.existsSync(electronIco) && fs.existsSync(buildIco)) return;

const ps1 = path.join(__dirname, 'generate-build-icon.ps1');
const r = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
  { stdio: 'inherit', windowsHide: true },
);
if (r.status !== 0) {
  process.stderr.write('ensure-icon: не удалось сгенерировать icon.ico (опционально для dev).\n');
}
