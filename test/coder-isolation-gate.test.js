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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCoderRun } from '../src/commands/coder.js';
import { ensureEnvFile, setVar } from '../src/secrets.js';

const CREDENTIAL_KEYS = [
  'ZHIPU_API_KEY',
  'OPENCODE_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'TRISS_WORKER_API_KEY',
];

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
    credentials: Object.fromEntries(CREDENTIAL_KEYS.map((key) => [key, process.env[key]])),
  };
  process.env.HOME = dir;
  process.env.TRISS_PROJECT_ROOT = dir;
  process.env.XDG_CONFIG_HOME = join(dir, '.config');
  delete process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
  for (const key of CREDENTIAL_KEYS) delete process.env[key];
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
    for (const key of CREDENTIAL_KEYS) {
      if (snap.credentials[key] === undefined) delete process.env[key];
      else process.env[key] = snap.credentials[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeCanonicalGlobalStore(dir, content) {
  const path = join(dir, '.config', 'triss', '.env');
  mkdirSync(join(dir, '.config', 'triss'), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
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

for (const credentialKey of CREDENTIAL_KEYS) {
  test(`ISOLATION-GATE-01-global-${credentialKey}: the canonical global store refuses before spawn`, () => withIsolatedStore(null, async ({ dir }) => {
    const globalPath = writeCanonicalGlobalStore(dir, `${credentialKey}=secret-value\n`);
    let spawned = false;
    await assert.rejects(
      () => runCoderRun('do something', {}, {
        spawn: () => {
          spawned = true;
          return fakeSpawnReplaying('')();
        },
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        stdoutWrite: () => true,
      }),
      (err) => {
        assert.match(err.message, /raw credential store/);
        assert.ok(err.message.includes(globalPath), 'the error identifies the canonical global store');
        return true;
      },
    );
    assert.equal(spawned, false, 'the engine must never spawn');
  }));
}

test('ISOLATION-GATE-global-writer: the canonical setup writer and run gate use the same global store', () => withIsolatedStore(null, async () => {
  const globalPath = ensureEnvFile('global');
  setVar(globalPath, 'ZHIPU_API_KEY', 'zk-saved-by-setup');
  let spawned = false;
  await assert.rejects(
    () => runCoderRun('do something', {}, {
      spawn: () => {
        spawned = true;
        return fakeSpawnReplaying('')();
      },
      spawnSync: () => ({ status: 1, stdout: '', error: null }),
      stdoutWrite: () => true,
    }),
    (err) => {
      assert.match(err.message, /raw credential store/);
      assert.ok(err.message.includes(globalPath), 'the gate reports the store written by setup');
      return true;
    },
  );
  assert.equal(spawned, false, 'the engine must never spawn');
}));

test('ISOLATION-GATE-02: the operator ack (deps.allowBestEffortIsolation) allows the run', () => withIsolatedStore('ZHIPU_API_KEY=zk-secret-key\n', async () => {
  let spawned = false;
  try {
    await runCoderRun('do something', {}, {
      allowBestEffortIsolation: true,
      disableCredentialProxy: true,
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
      credentialModeParentEnv: { TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: '1' },
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
      disableCredentialProxy: true,
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

for (const [label, content] of [
  ['empty', ''],
  ['control-only', 'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=0\n'],
]) {
  test(`ISOLATION-GATE-global-negative-${label}: a non-credential canonical global store does not block`, () => withIsolatedStore(null, async ({ dir }) => {
    writeCanonicalGlobalStore(dir, content);
    let spawned = false;
    try {
      await runCoderRun('do something', {}, {
        disableCredentialProxy: true,
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
    assert.equal(spawned, true, 'the engine spawns when the global store has no credential material');
  }));
}

test('ISOLATION-GATE-global-raw-ack: the explicit raw acknowledgement allows a canonical global credential store', () => withIsolatedStore(null, async ({ dir }) => {
  writeCanonicalGlobalStore(dir, 'ZHIPU_API_KEY=zk-secret-key\n');
  let spawned = false;
  try {
    await runCoderRun('do something', {}, {
      credentialModeParentEnv: { TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: '1' },
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
  assert.equal(spawned, true, 'the engine spawns under the acknowledged raw mode');
}));

test('ISOLATION-GATE-shell-only: a shell credential with empty canonical stores passes the store gate in protected mode', () => withIsolatedStore('', async ({ dir }) => {
  writeCanonicalGlobalStore(dir, '');
  let spawned = false;
  try {
    await runCoderRun('do something', {}, {
      disableCredentialProxy: true,
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
  assert.equal(spawned, true, 'the engine spawns when the credential exists only in the shell');
}));
