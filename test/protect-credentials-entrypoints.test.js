/**
 * protect-credentials-entrypoints.test.js — public contract for the
 * credential-mode switch (docs/plans/2025-protect-credentials-default.md):
 *
 *   | engine    | without the flag | with --protect-credentials        |
 *   |-----------|------------------|-----------------------------------|
 *   | opencode  | best_effort_raw  | protected_proxy                   |
 *   | opencode2 | best_effort_raw  | protected_proxy                   |
 *   | crush     | protected_proxy  | protected_proxy (flag is a no-op) |
 *
 * Covers the user-facing entry points (--protect-credentials on `coder run`,
 * `coder init`, and `exec --code`; --coder-protect-credentials on
 * `config wizard coder`) and the crush engine's unchanged mandatory proxy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'triss.js');

function help(args) {
  const res = spawnSync(process.execPath, [BIN, ...args, '--help'], {
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
    encoding: 'utf8',
  });
  // Commander wraps long descriptions at the column limit; flatten whitespace
  // so phrase assertions survive the wrapping.
  return (res.stdout + res.stderr).replace(/\s+/gu, ' ');
}

test('help: triss coder run documents --protect-credentials', () => {
  const out = help(['coder', 'run']);
  assert.match(out, /--protect-credentials/u);
  assert.match(out, /parent-owned credential proxy/u);
  assert.match(out, /Crush is always protected/u);
});

test('help: triss coder init documents --protect-credentials', () => {
  const out = help(['coder', 'init']);
  assert.match(out, /--protect-credentials/u);
  assert.match(out, /Fails closed when protected credential isolation cannot be enforced/u);
});

test('help: triss exec forwards --protect-credentials for the coder route', () => {
  const out = help(['exec']);
  assert.match(out, /--protect-credentials/u);
});

test('help: config wizard documents --coder-protect-credentials', () => {
  const out = help(['config', 'wizard']);
  assert.match(out, /--coder-protect-credentials/u);
  assert.match(out, /coder init.*uses --protect-credentials/u);
});

// ─── Crush: the mandatory parent-owned proxy is unchanged by the flag ────────

const CRUSH_PIN_SH = (cmd, argv) => {
  if (cmd === 'crush' && argv?.[0] === '--version') {
    return { status: 0, stdout: 'crush version v0.1.6\n', stderr: '', error: null };
  }
  return { status: 1, stdout: '', stderr: '', error: null };
};

for (const [label, extraOpts] of [
  ['without the flag (crush is always protected)', {}],
  ['with --protect-credentials (a documented no-op for crush)', { protectCredentials: true }],
]) {
  test(`crush run still requires the parent-owned proxy ${label}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'triss-crush-cred-'));
    const saved = {
      HOME: process.env.HOME,
      ROOT: process.env.TRISS_PROJECT_ROOT,
      ZHIPU: process.env.ZHIPU_API_KEY,
      MODEL: process.env.TRISS_CODER_MODEL,
      SMALL: process.env.TRISS_CODER_SMALL_MODEL,
    };
    process.env.HOME = dir;
    process.env.TRISS_PROJECT_ROOT = dir;
    delete process.env.TRISS_CODER_MODEL;
    delete process.env.TRISS_CODER_SMALL_MODEL;
    process.env.ZHIPU_API_KEY = 'zk-fake-test-key';
    t.after(() => {
      process.env.HOME = saved.HOME;
      if (saved.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = saved.ROOT;
      if (saved.ZHIPU === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = saved.ZHIPU;
      if (saved.MODEL === undefined) delete process.env.TRISS_CODER_MODEL;
      else process.env.TRISS_CODER_MODEL = saved.MODEL;
      if (saved.SMALL === undefined) delete process.env.TRISS_CODER_SMALL_MODEL;
      else process.env.TRISS_CODER_SMALL_MODEL = saved.SMALL;
      rmSync(dir, { recursive: true, force: true });
    });

    const { runCoderRun } = await import('../src/commands/coder.js');
    let spawned = false;
    await assert.rejects(
      () => runCoderRun('do work', {
        engine: 'crush',
        isolate: false,
        timeout: 5,
        cwd: dir,
        ...extraOpts,
      }, {
        spawnSync: CRUSH_PIN_SH,
        spawn: () => {
          spawned = true;
          throw new Error('the engine must never spawn without its proxy');
        },
        // Deliberately unusable proxy options: if (and only if) the run still
        // requires the parent-owned proxy, startup fails BEFORE any spawn.
        credentialProxyOptions: { host: '256.256.256.256', port: -1 },
        stdoutWrite: () => {},
      }),
      /credential proxy.*failed to start|requires the parent-owned/iu,
    );
    assert.equal(spawned, false, 'crush must never spawn with a raw credential');
  });
}
