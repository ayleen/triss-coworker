/**
 * coder-isolation-gate.test.js — security regression: a best-effort coder run is
 * refused BEFORE spawn whenever a raw credential store is readable by the
 * same-UID engine child, unless the operator explicitly acknowledged the
 * best-effort scope.
 *
 * All tests are hermetic and run against isolated temporary environments.
 * Verifies both the fail-closed rejection on non-empty stores (including
 * non-standard variable names) and the pass-through for empty/comment stores
 * or explicit operator acknowledgments.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCoderRun } from '../src/commands/coder.js';

function fakeSpawnReplaying(streamText, { code = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.pid = 555555;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(streamText);
      child.stderr.end('');
      setImmediate(() => child.emit('close', code, null));
    });
    return child;
  };
}

async function withIsolatedStore(envContent, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'triss-iso-gate-'));
  if (envContent !== null && envContent !== undefined) {
    writeFileSync(join(dir, '.triss.env'), envContent, 'utf8');
  }
  const snap = {
    HOME: process.env.HOME,
    TRISS_PROJECT_ROOT: process.env.TRISS_PROJECT_ROOT,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION,
    ZHIPU_API_KEY: process.env.ZHIPU_API_KEY,
  };
  process.env.HOME = dir;
  process.env.TRISS_PROJECT_ROOT = dir;
  process.env.XDG_CONFIG_HOME = join(dir, '.config');
  delete process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
  process.env.ZHIPU_API_KEY = 'zk-fake-test-key';
  try {
    await fn({ dir });
  } finally {
    process.env.HOME = snap.HOME;
    if (snap.TRISS_PROJECT_ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = snap.TRISS_PROJECT_ROOT;
    if (snap.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = snap.XDG_CONFIG_HOME;
    if (snap.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION === undefined) delete process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
    else process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION = snap.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
    if (snap.ZHIPU_API_KEY === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = snap.ZHIPU_API_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('ISOLATION-GATE-01: a readable raw credential store refuses the run before spawn', () => withIsolatedStore('ZHIPU_API_KEY=zk-secret-key\n', async () => {
  let spawned = false;
  try {
    await runCoderRun('do something', {}, {
      spawn: () => {
        spawned = true;
        return fakeSpawnReplaying('')();
      },
      spawnSync: () => ({ status: 1, stdout: '', error: null }),
      stdoutWrite: () => true,
    });
    assert.fail('the run must refuse');
  } catch (err) {
    assert.match(err.message, /raw credential store/);
    assert.match(err.message, /TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION/);
  }
  assert.equal(spawned, false, 'the engine must never spawn');
}));

test('ISOLATION-GATE-02: the operator ack (deps.allowBestEffortIsolation) allows the run', () => withIsolatedStore('ZHIPU_API_KEY=zk-secret-key\n', async () => {
  let spawned = false;
  try {
    await runCoderRun('do something', {}, {
      allowBestEffortIsolation: true,
      spawn: () => {
        spawned = true;
        return fakeSpawnReplaying('')();
      },
      spawnSync: () => ({ status: 1, stdout: '', error: null }),
      stdoutWrite: () => true,
    });
  } catch (err) {
    assert.doesNotMatch(err.message, /raw credential store/);
  }
  assert.equal(spawned, true, 'the engine spawns under the acknowledged best-effort scope');
}));

test('ISOLATION-GATE-03: the env ack (TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1) allows the run', () => withIsolatedStore('ZHIPU_API_KEY=zk-secret-key\n', async () => {
  process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION = '1';
  let spawned = false;
  try {
    await runCoderRun('do something', {}, {
      spawn: () => {
        spawned = true;
        return fakeSpawnReplaying('')();
      },
      spawnSync: () => ({ status: 1, stdout: '', error: null }),
      stdoutWrite: () => true,
    });
  } catch (err) {
    assert.doesNotMatch(err.message, /raw credential store/);
  }
  assert.equal(spawned, true, 'the engine spawns under env-acknowledged best-effort scope');
}));

test('ISOLATION-GATE-04: an empty (0-byte) or comment-only .triss.env does not refuse the run', () => withIsolatedStore('# comment only\n\n', async () => {
  let spawned = false;
  try {
    await runCoderRun('do something', {}, {
      spawn: () => {
        spawned = true;
        return fakeSpawnReplaying('')();
      },
      spawnSync: () => ({ status: 1, stdout: '', error: null }),
      stdoutWrite: () => true,
    });
  } catch (err) {
    assert.doesNotMatch(err.message, /raw credential store/);
  }
  assert.equal(spawned, true, 'empty store does not block execution');
}));

test('ISOLATION-GATE-05: fail-closed policy — any non-empty variable in .triss.env refuses before spawn', () => withIsolatedStore('GLM_CUSTOM_CREDENTIAL=secret-token\n', async () => {
  let spawned = false;
  try {
    await runCoderRun('do something', {}, {
      spawn: () => {
        spawned = true;
        return fakeSpawnReplaying('')();
      },
      spawnSync: () => ({ status: 1, stdout: '', error: null }),
      stdoutWrite: () => true,
    });
    assert.fail('the run must refuse');
  } catch (err) {
    assert.match(err.message, /raw credential store/);
    assert.match(err.message, /TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION/);
  }
  assert.equal(spawned, false, 'arbitrary non-empty key refuses fail-closed');
}));
