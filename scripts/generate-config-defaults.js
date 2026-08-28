#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen


import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG_DEFAULTS } from '../src/config-defaults.js';

const check = process.argv.includes('--check');

function replaceBlock(path, start, end, body) {
  const absolute = resolve(path);
  const current = readFileSync(absolute, 'utf8');
  const pattern = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  if (!pattern.test(current)) throw new Error(`${path}: generated-default markers are missing`);
  const next = current.replace(pattern, `${start}\n${body}\n${end}`);
  if (check && next !== current) {
    process.stderr.write(`${path}: generated configuration defaults are stale; run npm run docs:defaults\n`);
    process.exitCode = 1;
    return;
  }
  if (!check && next !== current) writeFileSync(absolute, next);
}

const rows = Object.entries(CONFIG_DEFAULTS)
  .map(([name, item]) => `| \`${name}\` | \`${item.value}\` | ${item.description} |`)
  .join('\n');
const table = [
  '| Variable | Default | Effect |',
  '| --- | --- | --- |',
  rows,
].join('\n');
replaceBlock(
  'docs/configuration.md',
  '<!-- config-defaults:start -->',
  '<!-- config-defaults:end -->',
  table,
);

const env = Object.entries(CONFIG_DEFAULTS)
  .map(([name, item]) => `# ${item.description}\n# ${name}=${item.envExample}`)
  .join('\n\n');
replaceBlock(
  '.env.example',
  '# config-defaults:start',
  '# config-defaults:end',
  env,
);

if (!process.exitCode) process.stdout.write(check ? 'generated configuration defaults are current\n' : 'generated configuration defaults updated\n');
