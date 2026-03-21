#!/usr/bin/env node
'use strict';

try {
  // eslint-disable-next-line import/no-dynamic-require
  const pkg = require('../node_modules/discord-rpc/package.json');
  // eslint-disable-next-line no-console
  console.log('version=', pkg && pkg.version ? pkg.version : '(unknown)');
  // eslint-disable-next-line no-console
  console.log('deps=', pkg && pkg.dependencies ? Object.keys(pkg.dependencies).join(', ') : '(none)');
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('Failed to read discord-rpc/package.json:', e && e.message ? e.message : String(e));
  process.exit(1);
}

