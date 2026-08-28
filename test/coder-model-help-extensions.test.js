// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-model-help-extensions.test.js — RED contract test for help extensions
 *
 * Extends existing help regressions to verify exact OpenCode and Crush target
 * paths are mentioned correctly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'triss.js');

function help(args) {
  const res = spawnSync(process.execPath, [BIN, ...args, '--help'], {
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
    encoding: 'utf8',
  });
  return res.stdout + res.stderr;
}

test('RED-05: `triss coder models --help` must mention exact Crush config paths', () => {
  const out = help(['coder', 'models']);
  assert.ok(
    /\.crush\/crush\.json/.test(out),
    'coder models help must mention exact local Crush config path ./.crush/crush.json',
  );
  assert.ok(
    /\.local\/share\/crush\/crush\.json/.test(out),
    'coder models help must mention exact global Crush config path ~/.local/share/crush/crush.json',
  );
});

test('RED-06: `triss coder model set --help` must mention exact OpenCode and Crush config paths', () => {
  const out = help(['coder', 'model', 'set']);
  assert.ok(
    /\.config\/opencode\/opencode\.json/.test(out),
    'coder model set help must mention exact global OpenCode config path ~/.config/opencode/opencode.json',
  );
  assert.ok(
    /opencode\.json/.test(out),
    'coder model set help must mention local OpenCode config path opencode.json',
  );
  assert.ok(
    /\.crush\/crush\.json/.test(out),
    'coder model set help must mention exact local Crush config path ./.crush/crush.json',
  );
  assert.ok(
    /\.local\/share\/crush\/crush\.json/.test(out),
    'coder model set help must mention exact global Crush config path ~/.local/share/crush/crush.json',
  );
});