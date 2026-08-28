// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Subprocess smoke tests for the bin/triss.js CLI entrypoint — the real
// bootstrap, argument parsing, command dispatch, and the error wrapper run
// in a child Node so the coverage propagated through NODE_V8_COVERAGE
// counts toward the bin/** scope of test:coverage.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'triss.js');

function runCli(args, { expectStatus = 0 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'triss-cli-home-'));
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TRISS_PROJECT_ROOT: home,
      // No worker key: exercises the no-config paths without network.
      TRISS_WORKER_API_KEY: '',
      CI: '1',
      NO_COLOR: '1',
    },
  });
  if (expectStatus === 0) {
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return result;
}

test('cli: --version prints the package version', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const out = runCli(['--version']);
  assert.match(out.stdout, new RegExp(pkg.version));
});

test('cli: --help exits zero and lists the command catalogue', () => {
  const out = runCli(['--help']);
  assert.match(out.stdout, /Usage/i);
  for (const cmd of ['ask', 'config', 'coder', 'mcp', 'review', 'usage']) {
    assert.match(out.stdout, new RegExp(`\\b${cmd}\\b`), `help should mention ${cmd}`);
  }
});

test('cli: unknown commands fail with a nonzero status and a helpful error', () => {
  const out = runCli(['definitely-not-a-command'], { expectStatus: 1 });
  assert.notEqual(out.status, 0);
  const text = `${out.stdout}${out.stderr}`;
  assert.match(text, /unknown|invalid|not/i);
});

test('cli: status without configuration still renders the full report and exits zero', () => {
  const out = runCli(['status']);
  assert.match(out.stdout, /Triss Coworker — status/);
  assert.match(out.stdout, /TRISS_WORKER_API_KEY\s+\(unset\)/);
  assert.match(out.stdout, /⚠ missing/);
});
