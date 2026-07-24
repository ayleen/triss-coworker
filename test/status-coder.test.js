/**
 * status-coder.test.js — `triss status`'s "Coder" block.
 *
 * Gated on envReadiness(CODER_MANIFEST).ready (ZHIPU_API_KEY), so a user who
 * hasn't configured coder never has `triss status` fork opencode/crush/git on
 * their behalf. With the key set, the block reports BOTH engines (opencode #1,
 * crush #2), the default engine a bare `triss coder run` resolves to, and the
 * live-worktree count. Engine detection is injected via deps.spawnSync so the
 * crush-present / crush-absent lines are deterministic without the binary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStatus } from '../src/commands/status.js';
import { stripAnsi } from './_ansi.js';

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

// Fake spawnSync for describeCoderStatus: returns a version for the requested
// engine only when one is provided; everything else (git, the other engine)
// exits non-zero so worktreeCount stays 0 and the absent engine reads
// "not installed". Mirrors how coder.js injects deps.spawnSync.
function fakeSh({ crushVersion = null, opencodeVersion = null } = {}) {
  return (cmd, args) => {
    if (cmd === 'crush' && args[0] === '--version') {
      return crushVersion != null
        ? { status: 0, stdout: crushVersion, stderr: '', error: null }
        : { status: 1, stdout: '', stderr: '', error: null };
    }
    if (cmd === 'opencode' && args[0] === '--version') {
      return opencodeVersion != null
        ? { status: 0, stdout: opencodeVersion, stderr: '', error: null }
        : { status: 1, stdout: '', stderr: '', error: null };
    }
    return { status: 1, stdout: '', stderr: '', error: null };
  };
}

function withTmpKey(fn) {
  return async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-status-')));
    const origCwd = process.cwd();
    const origHome = process.env.HOME;
    const origKey = process.env.ZHIPU_API_KEY;
    process.env.HOME = dir;
    process.env.ZHIPU_API_KEY = 'zk-fake-test-key';
    process.chdir(dir);
    try {
      await fn();
    } finally {
      process.chdir(origCwd);
      process.env.HOME = origHome;
      if (origKey === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = origKey;
      rmSync(dir, { recursive: true, force: true });
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
    const out = stripAnsi(await captureStdout(runStatus)());
    // Block is gated on the key — neither the header nor any engine line shows.
    assert.doesNotMatch(out, /^Coder$/m);
    assert.doesNotMatch(out, /default engine/);
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

test(
  'runStatus: the coder block appears with both engines + the default-engine indicator when ZHIPU_API_KEY is configured',
  withTmpKey(async () => {
    const out = stripAnsi(await captureStdout(() => runStatus({ spawnSync: fakeSh({ opencodeVersion: '1.17.18' }) }))());
    assert.match(out, /^Coder$/m);
    assert.match(out, /default engine\s+opencode/);
    assert.match(out, /worktrees \(\.triss\/wt\)/);
    // opencode section.
    assert.match(out, /opencode\s+1\.17\.18/);
    assert.match(out, /opencode\.json \[global\]/);
    // crush section (absent here — fake didn't report a crush version).
    assert.match(out, /crush\s+not installed/);
    assert.match(out, /crush\.json \[global\]/);
  }),
);

test(
  'runStatus: shows the crush version with a pin-check label when crush is detected',
  withTmpKey(async () => {
    const dirty = 'crush version v0.0.0-20260704214312-f45bb790a171+dirty';
    const out = stripAnsi(
      await captureStdout(() => runStatus({ spawnSync: fakeSh({ crushVersion: dirty }) }))(),
    );
    // crush ≥0.1.3 reports a clean semver and detect() parses the numeric
    // core, so the dirty dev string surfaces as the bare `0.0.0` — below the
    // pin, so it's flagged yellow with the pin (mirrors opencode's
    // below-pin label). The raw +dirty marker no longer appears in the label.
    assert.match(out, /crush\s+0\.0\.0/);
    assert.match(out, /pin: 0\.1\.7/);
    assert.match(out, /crush\.json \[global\]/);
    assert.match(out, /crush\.json \[local\]/);
  }),
);

test(
  'runStatus: crush absence never crashes — opencode-only users see a clean "not installed" line',
  withTmpKey(async () => {
    const out = stripAnsi(await captureStdout(() => runStatus({ spawnSync: fakeSh({}) }))());
    assert.match(out, /crush\s+not installed/);
    // opencode line still renders independently.
    assert.match(out, /opencode/);
  }),
);

test(
  'runStatus: the default-engine indicator reflects TRISS_CODER_ENGINE',
  withTmpKey(async () => {
    const saved = process.env.TRISS_CODER_ENGINE;
    process.env.TRISS_CODER_ENGINE = 'crush';
    try {
      const out = stripAnsi(await captureStdout(() => runStatus({ spawnSync: fakeSh({}) }))());
      assert.match(out, /default engine\s+crush/);
    } finally {
      if (saved === undefined) delete process.env.TRISS_CODER_ENGINE;
      else process.env.TRISS_CODER_ENGINE = saved;
    }
  }),
);
