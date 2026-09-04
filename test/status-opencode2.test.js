// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStatus } from '../src/commands/status.js';
import { stripAnsi } from './_ansi.js';

const BETA_VERSION = '0.0.0-beta-19059';
const COMPATIBLE_HELP = [
  '--standalone',
  '--format choice',
  '--auto',
  '--model, -m string  Model to use in the format provider/model#variant',
].join('\n');

function captureStdout(fn) {
  return async () => {
    const original = process.stdout.write.bind(process.stdout);
    let output = '';
    process.stdout.write = (chunk) => {
      output += chunk;
      return true;
    };
    try {
      await fn();
      return output;
    } finally {
      process.stdout.write = original;
    }
  };
}

function statusSpawnSync(help) {
  const calls = [];
  const spawnSync = (command, args = []) => {
    calls.push([command, ...args]);
    if (command === 'which' && args[0] === 'opencode2') {
      return { status: 0, stdout: `${process.execPath}\n`, stderr: '' };
    }
    if (command === process.execPath && args[0] === '--version') {
      return { status: 0, stdout: `opencode2 v${BETA_VERSION}\n`, stderr: '' };
    }
    if (command === process.execPath && args[0] === 'run' && args[1] === '--help') {
      return { status: 0, stdout: help, stderr: '' };
    }
    if (command === 'ps') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  return { calls, spawnSync };
}

function withStatusEnv(fn) {
  return async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'triss-status-oc2-')));
    const originalCwd = process.cwd();
    const values = {
      HOME: root,
      TRISS_PROJECT_ROOT: root,
      TRISS_DEFAULT_PROVIDER: 'openai-compatible',
      TRISS_OPENAI_COMPATIBLE_API_KEY: 'status-test-key',
      TRISS_OPENAI_COMPATIBLE_MODEL: 'deepseek-v4-pro',
      TRISS_OPENAI_COMPATIBLE_SMALL_MODEL: 'deepseek-v4-flash',
    };
    const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.assign(process.env, values);
    writeFileSync(join(root, '.triss.env'), [
      'TRISS_CONFIG_SCHEMA=2',
      'TRISS_DEFAULT_PROVIDER=openai-compatible',
      'TRISS_OPENAI_COMPATIBLE_API_KEY=status-test-key',
      'TRISS_OPENAI_COMPATIBLE_MODEL=deepseek-v4-pro',
      'TRISS_OPENAI_COMPATIBLE_SMALL_MODEL=deepseek-v4-flash',
      '',
    ].join('\n'));
    process.chdir(root);
    try {
      await fn();
    } finally {
      process.chdir(originalCwd);
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  'status renders beta-19059 compatible when --model owns provider/model#variant',
  withStatusEnv(async () => {
    const fake = statusSpawnSync(COMPATIBLE_HELP);
    const output = stripAnsi(await captureStdout(() => runStatus({ spawnSync: fake.spawnSync }))());
    assert.match(output, /^Coder$/mu);
    assert.match(output, /opencode2\s+0\.0\.0-beta-19059 \(compatible\)/u);
    assert.equal(fake.calls.some((call) => call[1] === 'run' && call[2] === '--help'), true);
  }),
);

test(
  'status reports model#variant when the --model record lacks variant grammar',
  withStatusEnv(async () => {
    const fake = statusSpawnSync(COMPATIBLE_HELP.replace('provider/model#variant', 'provider/model'));
    const output = stripAnsi(await captureStdout(() => runStatus({ spawnSync: fake.spawnSync }))());
    assert.match(output, /opencode2\s+0\.0\.0-beta-19059 \(incompatible CLI; missing model#variant\)/u);
    assert.doesNotMatch(output, /missing --variant/u);
  }),
);
