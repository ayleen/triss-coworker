#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['bin', 'scripts', 'src', 'test'];
const files = [];

function visit(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) visit(child);
    else if (/\.(?:c|m)?js$/.test(entry.name)) files.push(child);
  }
}

for (const root of roots) visit(resolve(root));
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
process.stdout.write(`syntax check passed for ${files.length} JavaScript files\n`);
