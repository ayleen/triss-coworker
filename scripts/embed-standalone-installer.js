#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen


import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const bootstrapPath = resolve(here, 'standalone-bootstrap.js');
const installerPath = resolve(root, 'install.sh');
const start = 'exec node --input-type=module - "$@" <<\'TRISS_STANDALONE_BOOTSTRAP\'\n';
const end = 'TRISS_STANDALONE_BOOTSTRAP\n';

function embedded(source, installer) {
  const begin = installer.indexOf(start);
  if (begin < 0) throw new Error('install.sh is missing the standalone bootstrap marker');
  const bodyStart = begin + start.length;
  const bodyEnd = installer.indexOf(end, bodyStart);
  if (bodyEnd < 0) throw new Error('install.sh is missing the bootstrap terminator');
  return `${installer.slice(0, bodyStart)}${source}${installer.slice(bodyEnd)}`;
}

const source = readFileSync(bootstrapPath, 'utf8');
const current = readFileSync(installerPath, 'utf8');
const next = embedded(source, current);
if (process.argv.includes('--check')) {
  if (next !== current) {
    process.stderr.write('install.sh embedded bootstrap is stale; run node scripts/embed-standalone-installer.js\n');
    process.exitCode = 1;
  }
} else {
  writeFileSync(installerPath, next, { mode: 0o755 });
}
