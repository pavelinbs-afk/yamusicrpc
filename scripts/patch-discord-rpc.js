/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');

function fileExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

const clientPath = path.join(
  __dirname,
  '..',
  'node_modules',
  'discord-rpc',
  'src',
  'client.js',
);

if (!fileExists(clientPath)) {
  console.log('[patch-discord-rpc] discord-rpc client.js not found, skip:', clientPath);
  process.exit(0);
}

let content = fs.readFileSync(clientPath, 'utf8');

// Idempotent: если уже добавили тип, ничего не делаем.
if (content.includes('type: args.type')) {
  console.log('[patch-discord-rpc] already patched');
  process.exit(0);
}

// Добавляем поле activity.type = args.type, чтобы Discord показывал "Слушает" и корректный тайм-бар.
// Ожидаемый фрагмент в оригинале:
// activity: {
//   state: args.state,
// ...
//
// Патчим так:
// activity: {
//   type: args.type,
//   state: args.state,
//
const re = /(activity:\s*{\s*\n)([ \t]*)state:\s*args\.state,/m;
if (!re.test(content)) {
  console.log('[patch-discord-rpc] pattern not found, skip');
  process.exit(0);
}

content = content.replace(re, `$1$2type: args.type,\n$2state: args.state,`);

fs.writeFileSync(clientPath, content, 'utf8');
console.log('[patch-discord-rpc] patched:', clientPath);

