// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const checker = join(repoRoot, 'scripts', 'check-doc-links.js');

test('documentation link checker rejects special filesystem targets', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'triss-doc-links-'));
  const target = join(root, 'special-target');
  const fifo = spawnSync('mkfifo', [target], { encoding: 'utf8' });
  assert.equal(fifo.status, 0, fifo.stderr || fifo.stdout);
  writeFileSync(join(root, 'README.md'), '[special](special-target)\n');

  const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a regular file or directory/);
});
