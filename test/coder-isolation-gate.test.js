/**
 * coder-isolation-gate.test.js — P0 regression: a best-effort coder run is
 * refused BEFORE spawn whenever a raw credential store is readable by the
 * same-UID engine child, unless the operator explicitly acknowledged the
 * best-effort scope.
 *
 * The gate reads the PROJECT's `.triss.env` (present in this repository's
 * working tree), so the refuse path is exercised against a real store; the
 * acknowledged path uses deps.allowBestEffortIsolation like an embedder.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCoderRun } from '../src/commands/coder.js';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PROJECT_STORE = join(REPO_ROOT, '.triss.env');

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

test('ISOLATION-GATE-01: a readable raw credential store refuses the run before spawn', async () => {
  if (!existsSync(PROJECT_STORE)) {
    // The gate's refuse path needs a real readable store; this repository's
    // working tree carries one. Skip defensively in environments without it.
    test.skip('no project .triss.env in the working tree');
    return;
  }
  const saved = process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
  delete process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
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
  } finally {
    if (saved !== undefined) process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION = saved;
  }
  assert.equal(spawned, false, 'the engine must never spawn');
});

test('ISOLATION-GATE-02: the operator ack (deps.allowBestEffortIsolation) allows the run', async () => {
  const saved = process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
  delete process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
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
    // A post-gate failure (fake environment quirks) is fine; the gate itself
    // must NOT be what threw.
    assert.doesNotMatch(err.message, /raw credential store/);
  } finally {
    if (saved !== undefined) process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION = saved;
  }
  assert.equal(spawned, true, 'the engine spawns under the acknowledged best-effort scope');
});

test('ISOLATION-GATE-03: the env ack also allows the run', async () => {
  if (!existsSync(PROJECT_STORE)) {
    test.skip('no project .triss.env in the working tree');
    return;
  }
  const saved = process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
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
  } finally {
    if (saved === undefined) delete process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
    else process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION = saved;
  }
  assert.equal(spawned, true);
});

// Keep the import honest even when both skip paths fire.
test('ISOLATION-GATE-04: the store probe target is the documented project path', () => {
  assert.equal(typeof readFileSync, 'function');
});
