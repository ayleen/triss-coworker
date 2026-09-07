// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Review-round 8 regression tests for the setup-adjacent command surfaces:
//   - status reports a PERSISTED TRISS_CODER_ENGINE (the provider snapshot
//     has no engine atom and describeCoderStatus reads process.env only) and
//     distinguishes "default on" from an explicit protection choice;
//   - `triss config set` validates enum values against the canonical setup
//     inventory (bogus provider ids are rejected, canonical ones accepted);
//   - `triss init` registers --yes so non-TTY `init --setup` can work.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// picocolors snapshots NO_COLOR at import time — set it before any import of
// the modules under test so color codes never pollute the assertions.
process.env.NO_COLOR = '1';

const { runStatus } = await import('../src/commands/status.js');
const { runSet } = await import('../src/commands/config.js');

const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'triss.js');

function withTempHome(prefix, globalEnv, fn) {
  return async (t) => {
    const home = mkdtempSync(join(tmpdir(), prefix));
    const project = join(home, 'proj');
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });
    mkdirSync(project, { recursive: true });
    if (globalEnv) writeFileSync(join(home, '.config', 'triss', '.env'), globalEnv);
    const saved = {
      HOME: process.env.HOME,
      ROOT: process.env.TRISS_PROJECT_ROOT,
      USAGE: process.env.TRISS_USAGE_LOG,
      UPDATE: process.env.TRISS_UPDATE_CHECK,
      ENGINE: process.env.TRISS_CODER_ENGINE,
      PROTECT: process.env.TRISS_PROTECT_CREDENTIALS,
    };
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = project;
    process.env.TRISS_USAGE_LOG = '0';
    process.env.TRISS_UPDATE_CHECK = '0';
    delete process.env.TRISS_CODER_ENGINE;
    delete process.env.TRISS_PROTECT_CREDENTIALS;
    t.after(() => {
      process.env.HOME = saved.HOME;
      if (saved.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = saved.ROOT;
      if (saved.USAGE === undefined) delete process.env.TRISS_USAGE_LOG;
      else process.env.TRISS_USAGE_LOG = saved.USAGE;
      if (saved.UPDATE === undefined) delete process.env.TRISS_UPDATE_CHECK;
      else process.env.TRISS_UPDATE_CHECK = saved.UPDATE;
      if (saved.ENGINE === undefined) delete process.env.TRISS_CODER_ENGINE;
      else process.env.TRISS_CODER_ENGINE = saved.ENGINE;
      if (saved.PROTECT === undefined) delete process.env.TRISS_PROTECT_CREDENTIALS;
      else process.env.TRISS_PROTECT_CREDENTIALS = saved.PROTECT;
      rmSync(home, { recursive: true, force: true });
    });
    return fn({ home, project }, t);
  };
}

async function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (text) => {
    chunks.push(text);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

// ─── B15: status engine snapshot + protection wording ──────────────────────

test('status reports a persisted TRISS_CODER_ENGINE instead of assuming opencode', withTempHome('r8-status-engine-',
  'TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-status-test-1234\nTRISS_CODER_ENGINE=crush\n',
  async () => {
    const output = await captureStdout(() => runStatus());
    assert.match(output, /default engine\s+crush/, `the persisted engine is the default: ${output}`);
    assert.match(output, /coding engine\s+crush/, `the persisted engine is named: ${output}`);
    // Engine-default protection (no explicit choice): "default on" wording.
    assert.match(output, /protected credential mode\s+default on \(crush\)/);
  }));

test('status reports an explicit protection choice as user-set, not "default on"', withTempHome('r8-status-protect-',
  'TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-status-test-1234\nTRISS_CODER_ENGINE=opencode\nTRISS_PROTECT_CREDENTIALS=true\n',
  async () => {
    const output = await captureStdout(() => runStatus());
    assert.match(output, /protected credential mode\s+on \(persisted TRISS_PROTECT_CREDENTIALS=true\)/);
    assert.doesNotMatch(output, /default on \(crush\)/);
  }));

test('status reports an explicit protection OFF choice without offering the default', withTempHome('r8-status-off-',
  'TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-status-test-1234\nTRISS_PROTECT_CREDENTIALS=false\n',
  async () => {
    const output = await captureStdout(() => runStatus());
    assert.match(output, /protected credential mode\s+off \(persisted TRISS_PROTECT_CREDENTIALS=false\)/);
  }));

// ─── B16: config set validates enum values ─────────────────────────────────

test('config set rejects a bogus provider id and accepts a canonical one', withTempHome('r8-config-set-', '', async ({ home }) => {
  await assert.rejects(
    () => runSet('TRISS_DEFAULT_PROVIDER', 'za1', { global: true }),
    (err) => {
      assert.match(err.message, /"TRISS_DEFAULT_PROVIDER" must be one of:/);
      assert.match(err.message, /zai/);
      return true;
    },
  );
  await assert.rejects(
    () => runSet('TRISS_CODER_ENGINE', 'vscode', { global: true }),
    /"TRISS_CODER_ENGINE" must be one of:/,
  );
  await runSet('TRISS_DEFAULT_PROVIDER', 'moonshot', { global: true });
  const content = readFileSync(join(home, '.config', 'triss', '.env'), 'utf8');
  assert.match(content, /TRISS_DEFAULT_PROVIDER=moonshot/);
}));

// ─── B11: init registers --yes for non-TTY init --setup ────────────────────

test('triss init registers --yes (visible in help, accepted on the CLI)', (t) => {
  const env = {
    PATH: process.env.PATH,
    HOME: mkdtempSync(join(tmpdir(), 'r8-init-help-home-')),
    NO_COLOR: '1',
    TRISS_UPDATE_CHECK: '0',
  };
  t.after(() => rmSync(env.HOME, { recursive: true, force: true }));

  const help = spawnSync(process.execPath, [BIN, 'init', '--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 0, `init --help must succeed: ${help.stderr}`);
  assert.match(help.stdout, /--yes/, '--yes must be registered on the init command');

  // Non-TTY `init --setup` without --yes fails at the wizard's interactive
  // guard with the actionable message (and never with a Commander error).
  const guarded = spawnSync(process.execPath, [BIN, 'init', '--setup'], { env, encoding: 'utf8' });
  assert.equal(guarded.status, 1);
  assert.match(guarded.stderr, /--yes/);
  assert.doesNotMatch(guarded.stderr, /unknown option/i);

  // With --yes the wizard proceeds headlessly and fails on the MISSING
  // CREDENTIAL (a real completeness check), never on flag parsing.
  const headless = spawnSync(process.execPath, [BIN, 'init', '--setup', '--yes'], {
    env: { ...env, TRISS_PROJECT_ROOT: env.HOME },
    encoding: 'utf8',
  });
  assert.equal(headless.status, 1);
  assert.doesNotMatch(headless.stderr, /unknown option/i);
  assert.match(headless.stderr, /TRISS_OPENAI_COMPATIBLE_API_KEY/);
});
