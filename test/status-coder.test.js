/**
 * status-coder.test.js — `triss status`'s "Coder (opencode engine)" block
 * is gated on envReadiness(CODER_MANIFEST).ready, so a user who hasn't
 * configured coder never has `triss status` fork opencode/git on their
 * behalf just to render a block they can't use.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStatus } from '../src/commands/status.js';

function captureStdout(fn) {
  return async () => {
    const orig = process.stdout.write.bind(process.stdout);
    let out = '';
    process.stdout.write = (s) => {
      out += s;
      return true;
    };
    try {
      await fn();
      return out;
    } finally {
      process.stdout.write = orig;
    }
  };
}

test('runStatus: the coder block is hidden when ZHIPU_API_KEY is not configured', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-status-nokey-')));
  const origCwd = process.cwd();
  const origHome = process.env.HOME;
  const origKey = process.env.ZHIPU_API_KEY;
  process.env.HOME = dir;
  delete process.env.ZHIPU_API_KEY;
  process.chdir(dir);
  try {
    const out = await captureStdout(runStatus)();
    assert.doesNotMatch(out, /Coder \(opencode engine\)/);
    // The generic manifest row (env var readiness) still shows.
    assert.match(out, /coder\s+⚠ missing ZHIPU_API_KEY/);
  } finally {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    if (origKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = origKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus: the coder block appears when ZHIPU_API_KEY is configured', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-status-withkey-')));
  const origCwd = process.cwd();
  const origHome = process.env.HOME;
  const origKey = process.env.ZHIPU_API_KEY;
  process.env.HOME = dir;
  process.env.ZHIPU_API_KEY = 'zk-fake-test-key';
  process.chdir(dir);
  try {
    const out = await captureStdout(runStatus)();
    assert.match(out, /Coder \(opencode engine\)/);
    assert.match(out, /worktrees \(\.triss\/wt\)/);
  } finally {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    if (origKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = origKey;
    rmSync(dir, { recursive: true, force: true });
  }
});
