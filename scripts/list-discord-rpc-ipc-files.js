#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'node_modules', 'discord-rpc', 'src');

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

try {
  const files = walk(root).filter((p) => /ipc/i.test(p) || /transport/i.test(p));
  for (const f of files) console.log(f);
} catch (e) {
  console.error('Failed to list files:', e && e.message ? e.message : String(e));
  process.exit(1);
}

