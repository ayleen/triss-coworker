/**
 * coder-session-owner-identity.test.js — host identity helpers,
 * production v2 reservation owner tuples, and failed-run rollback.
 *
 * RED/GREEN: node --test test/coder-session-owner-identity.test.js
 *
 * Focused coverage for the narrow identity port in src/commands/coder.js:
 * currentBootIdentity (Linux /proc boot_id + Darwin kern.boottime probe),
 * currentSessionOwnerTuple rejection of unavailable evidence, a REAL
 * reserveV2SessionRow admission persisting non-empty canonical identities,
 * the complete owner/run tuple contract: a failed/spawn-aborted run
 * removes its reserved/running row WITHOUT a rollback warning while a
 * successful completion still lands idle, a forced reserved->running
 * transition failure abandons the published row (no stranded inventory),
 * and a fail-closed V1 session-store lookup abandons the row reserved
 * before it.
 *
 * Explicit-session admission is fail-closed end to end: a mutex held
 * through the whole bounded retry schedule rejects CODER_SESSION_LOCK_TIMEOUT,
 * a corrupt canonical inventory rejects CODER_SESSION_STORE_INVALID (store
 * left byte-identical), and a parent-directory fsync failure AFTER a
 * successful rename rejects CODER_SESSION_DURABILITY_UNKNOWN with
 * publicationMayHaveOccurred=true while the published reserved row stays
 * recoverable — all three BEFORE spawn and never degraded to the
 * warning/null contract.
 *
 * Finalization seam (deps.sessionFinalization): the SAME narrow
 * acquireLock/lockRetryMs/inventoryFs mutex seams are forwarded into the
 * SUCCESS-path running->idle completion, proving a finalization failure
 * withholds the success envelope, stays typed (never fed into abandon),
 * and leaves the row exactly as the failed transition left it — plus that
 * a rollback colliding with a genuinely held lock throws the aggregate
 * preserving both errors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, open as fsOpen, readdir as fsReaddir, rename as fsRename, unlink as fsUnlink } from 'node:fs/promises';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import {
  INVENTORY_BASENAME,
  readCoderSessionInventory,
} from '../src/coder-session-inventory-codec.js';
import {
  INVENTORY_LOCK_BASENAME,
  sessionInventoryPath,
} from '../src/coder-session-transitions.js';
import { acquireCoderMutationLock } from '../src/coder-lock.js';
import {
  currentBootIdentity,
  currentSessionOwnerTuple,
  reserveV2SessionRow,
  runCoderRun,
} from '../src/commands/coder.js';
import { fakeEffectiveOpenCodeConfig } from './_opencode-effective-config.js';

test('currentBootIdentity reads Linux /proc boot_id into a stable prefixed string', () => {
  const uuid = '12345678-1234-1234-1234-123456789abc';
  let readPath = null;
  assert.equal(
    currentBootIdentity({
      platform: 'linux',
      readFile: (path) => {
        readPath = path;
        return `${uuid}\n`;
      },
    }),
    `linux:${uuid}`,
  );
  assert.equal(readPath, '/proc/sys/kernel/random/boot_id');
  // Malformed evidence must NOT become an identity.
  assert.equal(
    currentBootIdentity({ platform: 'linux', readFile: () => 'not-a-boot-id\n' }),
    null,
  );
});

test('currentBootIdentity probes Darwin via absolute sysctl with a minimal fixed env', () => {
  let call = null;
  assert.equal(
    currentBootIdentity({
      platform: 'darwin',
      spawnSync: (file, args, opts) => {
        call = { file, args, opts };
        return { status: 0, stdout: '{ sec = 12345, usec = 67 } Mon Aug 1' };
      },
    }),
    'darwin:12345:67',
  );
  assert.equal(call.file, '/usr/sbin/sysctl', 'sysctl must be invoked by its absolute path');
  assert.deepEqual(call.args, ['-n', 'kern.boottime']);
  assert.equal(call.opts.timeout, 1_000);
  assert.deepEqual(call.opts.stdio, ['ignore', 'pipe', 'ignore'], 'stdin/stderr must be ignored');
  assert.deepEqual(call.opts.env, { TZ: 'UTC', LC_ALL: 'C' }, 'parent env must never be forwarded');
  // Nonzero exit degrades to null instead of throwing.
  assert.equal(
    currentBootIdentity({
      platform: 'darwin',
      spawnSync: () => ({ status: 1, stdout: '' }),
    }),
    null,
  );
});

test('currentBootIdentity returns null on unknown platforms and currentSessionOwnerTuple rejects unavailable identity', () => {
  assert.equal(
    currentBootIdentity({
      platform: 'win32',
      readFile: () => {
        throw new Error('must not read');
      },
      spawnSync: () => {
        throw new Error('must not spawn');
      },
    }),
    null,
  );
  assert.deepEqual(
    currentSessionOwnerTuple({ pid: 12, processStartId: 'ps-12', bootId: 'boot-12' }),
    { pid: 12, processStartId: 'ps-12', bootId: 'boot-12' },
  );
  assert.throws(
    () => currentSessionOwnerTuple({ pid: 12, processStartId: '', bootId: 'boot-12' }),
    /owner identity is unavailable/,
  );
  assert.throws(
    () => currentSessionOwnerTuple({ pid: 12, processStartId: 'ps-12', bootId: '' }),
    /owner identity is unavailable/,
  );
});

test('production reservation persists one non-empty canonical owner tuple for both transitions', async () => {
  const base = await mkdtemp(join(tmpdir(), 'triss-owner-identity-'));
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = base;
  try {
    const expected = currentSessionOwnerTuple();
    const session = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'owner-proof',
      isolated: false,
    });
    assert.ok(session, 'admission must publish a canonical row when identity is available');
    const inventory = await readCoderSessionInventory(session.inventoryDir);
    assert.equal(inventory.entries.length, 1);
    const row = inventory.entries[0];
    // The single computed tuple reached BOTH the reserve and running
    // transitions: the persisted row carries exactly this run's evidence.
    assert.equal(row.state, 'running');
    assert.equal(row.pid, expected.pid);
    assert.equal(typeof row.process_start_id, 'string');
    assert.ok(row.process_start_id.length > 0, 'process_start_id must be non-empty');
    assert.equal(row.process_start_id, expected.processStartId);
    assert.equal(typeof row.boot_id, 'string');
    assert.ok(row.boot_id.length > 0, 'boot_id must be non-empty');
    assert.ok(
      /^(linux|darwin):/.test(row.boot_id),
      `boot_id must carry its platform prefix, got ${row.boot_id}`,
    );
    assert.equal(row.boot_id, expected.bootId);
    // The admission return carries the COMPLETE owner/run tuple, and every
    // field is EXACTLY the persisted canonical row's value — sandboxId is
    // captured from the reserved row, never invented a second time. This is
    // the tuple abandonV2SessionRow needs to pass beginCoderSessionDelete's
    // canonical validation.
    assert.match(session.sandboxId, /^sbx_[0-9a-f]{32}$/);
    assert.deepEqual(
      {
        runId: session.runId,
        sandboxId: session.sandboxId,
        pid: session.pid,
        processStartId: session.processStartId,
        bootId: session.bootId,
      },
      {
        runId: row.run_id,
        sandboxId: row.sandbox_id,
        pid: row.pid,
        processStartId: row.process_start_id,
        bootId: row.boot_id,
      },
      'the returned admission tuple must be the persisted canonical row tuple',
    );
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await rm(base, { recursive: true, force: true });
  }
});

// ─── partial reservation transition (reserved published, running lost) ───────
//
// reserveV2SessionRow publishes the `reserved` row BEFORE the
// reserved->running transition, so a markCoderSessionRunning failure used to
// lose the handle and strand the row behind a generic degradation warning.
// The complete handle is now built immediately after reserve succeeds (with
// reserved.sandbox_id + the exact owner/run tuple) and a failing transition
// best-effort abandons THAT handle before degrading. The narrow injectable
// seam (deps.markCoderSessionRunning) makes the failure deterministic while
// reserve itself stays REAL.

test('a forced reserved->running failure abandons the exact reserved row with no stranded inventory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'triss-owner-identity-'));
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = base;
  const stderr = captureStderr();
  try {
    const result = await reserveV2SessionRow(
      { engine: 'opencode', slug: 'markfail', isolated: false },
      {
        markCoderSessionRunning: async () => {
          throw new Error('forced mark failure');
        },
      },
    );
    assert.equal(result, null, 'admission degrades to null after the transition failure');
    // The ORIGINAL transition error surfaces through the existing warning,
    // and — because rollback SUCCEEDED — no rollback warning appears.
    assert.match(stderr.text(), /v2 session store unavailable: forced mark failure/);
    assert.doesNotMatch(
      stderr.text(),
      /v2 session rollback failed/,
      'a successful abandon must never warn',
    );
    const inventory = await readCoderSessionInventory(
      sessionInventoryPath(join(base, '.triss'), 'opencode'),
    );
    assert.deepEqual(inventory.entries, [], 'no stranded reserved row');
  } finally {
    stderr.restore();
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await rm(base, { recursive: true, force: true });
  }
});

// ─── admission code policy: closed stable-code allowlist ─────────────────────
//
// reserveV2SessionRow propagates ONLY the closed STABLE_SESSION_ADMISSION_CODES
// allowlist unchanged; a bare system code (e.g. EACCES) must wrap as
// CODER_SESSION_ADMISSION_FAILED with the original error preserved as cause.
// Driven through the same narrow deps.claimCoderSession seam as above while
// everything else stays REAL.

test('admission wraps bare system codes but lets allowlisted stable codes propagate unchanged', async () => {
  const base = await mkdtemp(join(tmpdir(), 'triss-owner-identity-'));
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = base;
  try {
    // A bare system code must NOT leak through unclassified.
    await assert.rejects(
      () =>
        reserveV2SessionRow(
          { engine: 'opencode', slug: 'wrap-proof', isolated: false },
          {
            claimCoderSession: async () => {
              const err = new Error('permission denied');
              err.code = 'EACCES';
              throw err;
            },
          },
        ),
      (err) => {
        assert.equal(err.code, 'CODER_SESSION_ADMISSION_FAILED');
        assert.match(err.message, /coder session admission failed/);
        assert.equal(err.cause?.code, 'EACCES', 'the original system error stays attached as cause');
        return true;
      },
    );
    // An allowlisted stable code keeps its exact code and message.
    await assert.rejects(
      () =>
        reserveV2SessionRow(
          { engine: 'opencode', slug: 'stable-proof', isolated: false },
          {
            claimCoderSession: async () => {
              const err = new Error('forced busy refusal');
              err.code = 'CODER_SESSION_BUSY';
              throw err;
            },
          },
        ),
      (err) => {
        assert.equal(err.code, 'CODER_SESSION_BUSY');
        assert.match(err.message, /forced busy refusal/);
        assert.equal(err.cause, undefined, 'allowlisted codes pass through unwrapped');
        return true;
      },
    );
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await rm(base, { recursive: true, force: true });
  }
});

// ─── failed-run rollback (real runCoderRun lifecycle) ────────────────────────
//
// Regression for the rollback bug exposed by the owner-identity repair:
// reserveV2SessionRow used to return only {inventoryDir,engine,slug}, so
// abandonV2SessionRow's beginCoderSessionDelete call lacked
// runId/sandboxId/pid/processStartId/bootId, failed canonical validation, and
// stranded the running row behind a "v2 session rollback failed" warning.

function withRunEnv(fn) {
  return async () => {
    const base = await mkdtemp(join(tmpdir(), 'triss-session-rollback-'));
    const keys = ['HOME', 'TRISS_PROJECT_ROOT', 'ZHIPU_API_KEY', 'TRISS_USAGE_LOG', 'TRISS_CODER_MODEL', 'TRISS_CODER_ENGINE'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.HOME = base;
    process.env.TRISS_PROJECT_ROOT = base;
    process.env.ZHIPU_API_KEY = 'zk-fake-test-key';
    process.env.TRISS_USAGE_LOG = '0';
    delete process.env.TRISS_CODER_MODEL;
    delete process.env.TRISS_CODER_ENGINE;
    try {
      await fn(base);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await rm(base, { recursive: true, force: true });
    }
  };
}

function spawnReplaying(streamText, { code = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.pid = 555777;
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

// abandonV2SessionRow degrades store failures to a dim stderr warning — the
// warning must stay suppressed-able only by CORRECT behavior, so capture it.
function captureStderr() {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

test('a failed run removes its reserved/running v2 row without a rollback warning', withRunEnv(async (base) => {
  const inventoryDir = sessionInventoryPath(join(base, '.triss'), 'opencode');
  let midRunSnapshot = null;
  const spawn = () => {
    // Reservation happens BEFORE spawn — snapshot the inventory exactly while
    // the run is live to prove a reserved/running row existed and is removed.
    midRunSnapshot = readCoderSessionInventory(inventoryDir);
    return spawnReplaying('', { code: 1 })(); // zero parseable output -> throw
  };
  const stderr = captureStderr();
  try {
    await assert.rejects(
      () =>
        runCoderRun('do something', { session: 'rollback-proof' }, {
          spawn,
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
          stdoutWrite: () => true,
        }),
      /produced no parseable output/,
    );
  } finally {
    stderr.restore();
  }
  assert.ok(midRunSnapshot, 'the engine branch must run AFTER reservation');
  const midRun = await midRunSnapshot;
  assert.equal(midRun.entries.length, 1, 'exactly one row exists while the run is live');
  assert.equal(midRun.entries[0].state, 'running');
  assert.equal(
    /v2 session rollback failed/.test(stderr.text()),
    false,
    `a clean failed-run rollback must never warn, got: ${stderr.text()}`,
  );
  const after = await readCoderSessionInventory(inventoryDir);
  assert.deepEqual(after.entries, [], 'the failed run must remove its reserved/running row');
}));

test('a successful run completes its v2 row to idle', withRunEnv(async (base) => {
  const streamText =
    JSON.stringify({ type: 'text', part: { text: 'done' } }) + '\n' +
    JSON.stringify({ type: 'step_finish', reason: 'stop' }) + '\n';
  await runCoderRun('do something', { session: 'idle-proof' }, {
    spawn: spawnReplaying(streamText, { code: 0 }),
    spawnSync: () => ({ status: 1, stdout: '', error: null }),
    effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
    stdoutWrite: () => true,
  });
  const inventory = await readCoderSessionInventory(sessionInventoryPath(join(base, '.triss'), 'opencode'));
  assert.equal(inventory.entries.length, 1, 'successful completion keeps exactly one row');
  assert.equal(inventory.entries[0].state, 'idle');
}));

// ─── V1 lookup failure after reservation ─────────────────────────────────────
//
// The row is reserved BEFORE `lookupSessionRealId` reads sessions.json. A
// fail-closed store read (malformed/unsupported shape) used to throw past
// the freshly reserved row; it must abandon that exact row first, so a
// corrupted store never strands running inventory behind a rollback
// warning.

test('a malformed legacy sessions.json fails the lookup closed and empties the v2 inventory', withRunEnv(async (base) => {
  mkdirSync(join(base, '.triss'), { recursive: true });
  // Legacy flat map with a non-string value -> normalizeSessionStore throws
  // fail-closed when the explicit-session lookup reads it.
  writeFileSync(join(base, '.triss', 'sessions.json'), JSON.stringify({ legacy: 42 }));
  const stderr = captureStderr();
  try {
    await assert.rejects(
      () =>
        runCoderRun('do something', { session: 'lookup-proof' }, {
          spawn: () => {
            throw new Error('must not spawn');
          },
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
          stdoutWrite: () => true,
        }),
      /malformed legacy entry/,
    );
  } finally {
    stderr.restore();
  }
  assert.doesNotMatch(
    stderr.text(),
    /v2 session rollback failed/,
    'a successful abandon must never warn',
  );
  const after = await readCoderSessionInventory(sessionInventoryPath(join(base, '.triss'), 'opencode'));
  assert.deepEqual(after.entries, [], 'the fail-closed lookup must abandon its reserved row');
}));

// ─── V1 continuation republishes running ownership ───────────────────────────
//
// Re-running the same OpenCode (V1-style) slug must reserve a FRESH canonical
// row each time — a new run_id/sandbox_id and a complete owner tuple visible
// while the run is live — and a subsequent failed attempt must remove ONLY its
// own row, preserving the completed run's idle row behind it.

test('OpenCode V1 continuation republishes running ownership and preserves idle on failure', withRunEnv(async (base) => {
  const inventoryDir = sessionInventoryPath(join(base, '.triss'), 'opencode');
  const successStream =
    JSON.stringify({ type: 'text', part: { text: 'done' } }) + '\n' +
    JSON.stringify({ type: 'step_finish', reason: 'stop' }) + '\n';
  const stderr = captureStderr();
  try {
    let firstSnapshot = null;
    await runCoderRun('do something', { session: 'v1-cont' }, {
      spawn: () => {
        // Reservation happens BEFORE spawn — snapshot the live running row.
        firstSnapshot = readCoderSessionInventory(inventoryDir);
        return spawnReplaying(successStream)();
      },
      spawnSync: () => ({ status: 1, stdout: '', error: null }),
      effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
      stdoutWrite: () => true,
    });
    const firstLive = await firstSnapshot;
    assert.equal(firstLive.entries.length, 1, 'exactly one row exists while the first run is live');
    assert.equal(firstLive.entries[0].state, 'running');
    const firstRunId = firstLive.entries[0].run_id;
    const firstSandboxId = firstLive.entries[0].sandbox_id;
    const afterFirst = await readCoderSessionInventory(inventoryDir);
    assert.equal(afterFirst.entries.length, 1);
    assert.equal(afterFirst.entries[0].state, 'idle', 'the first run must complete to idle');

    let secondSnapshot = null;
    await runCoderRun('do something', { session: 'v1-cont' }, {
      spawn: () => {
        secondSnapshot = readCoderSessionInventory(inventoryDir);
        return spawnReplaying(successStream)();
      },
      spawnSync: () => ({ status: 1, stdout: '', error: null }),
      effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
      stdoutWrite: () => true,
    });
    const secondLive = await secondSnapshot;
    assert.equal(secondLive.entries.length, 1, 'exactly one row exists while the rerun is live');
    assert.equal(secondLive.entries[0].state, 'running');
    const secondRow = secondLive.entries[0];
    assert.notEqual(secondRow.run_id, firstRunId, 'a continuation must publish a fresh run_id');
    assert.notEqual(secondRow.sandbox_id, firstSandboxId, 'a continuation must publish a fresh sandbox_id');
    for (const field of ['pid', 'process_start_id', 'boot_id']) {
      assert.ok(
        secondRow[field] !== null && secondRow[field] !== undefined,
        `owner tuple field ${field} must be non-null`,
      );
    }
    const afterSecond = await readCoderSessionInventory(inventoryDir);
    assert.equal(afterSecond.entries.length, 1);
    assert.equal(afterSecond.entries[0].state, 'idle', 'the rerun must complete to idle');
    assert.doesNotMatch(
      stderr.text(),
      /v2 session store unavailable|already reserved|v2 session rollback failed/,
      `clean continuations must never warn, got: ${stderr.text()}`,
    );

    await assert.rejects(
      () =>
        runCoderRun('do something', { session: 'v1-cont' }, {
          spawn: spawnReplaying('', { code: 1 }), // zero parseable output -> throw
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
          stdoutWrite: () => true,
        }),
      /no parseable output/,
    );
    const afterThird = await readCoderSessionInventory(inventoryDir);
    assert.equal(
      afterThird.entries.length,
      1,
      'the failed attempt must remove only its own row',
    );
    assert.equal(afterThird.entries[0].state, 'idle', 'the completed run stays idle');
  } finally {
    stderr.restore();
  }
}));

// ─── explicit-session admission fails closed before spawn ────────────────────
//
// reserveV2SessionRow's admission policy degrades to warning/null ONLY for a
// verified rollback (sessionRollbackVerified). Every typed store refusal —
// mutex still held after the bounded retry schedule, a corrupt canonical
// inventory, or durability unknown after a successful rename — must THROW
// out of runCoderRun with its stable code BEFORE the engine spawn, and must
// never surface as the dim degradation warning. Spawn counters prove the
// pre-spawn boundary; the inventory proves each refusal's exact store
// semantics.

test('a mutex held through the whole retry schedule rejects CODER_SESSION_LOCK_TIMEOUT before spawn', withRunEnv(async (base) => {
  const inventoryDir = sessionInventoryPath(join(base, '.triss'), 'opencode');
  const lockPath = join(inventoryDir, INVENTORY_LOCK_BASENAME);
  const lockAttempts = [];
  let spawnCalls = 0;
  const stderr = captureStderr();
  try {
    await assert.rejects(
      () =>
        runCoderRun('do something', { session: 'lock-timeout-proof' }, {
          spawn: () => {
            spawnCalls += 1;
            return spawnReplaying('', { code: 1 })();
          },
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
          stdoutWrite: () => true,
          sessionAdmission: {
            acquireLock: (path) => {
              lockAttempts.push(path);
              const err = new Error('forced lock contention');
              err.code = 'LOCK_HELD';
              throw err;
            },
            lockRetryMs: [0],
          },
        }),
      (err) => {
        assert.equal(err.code, 'CODER_SESSION_LOCK_TIMEOUT');
        assert.match(err.message, /mutex still held/);
        assert.equal(err.lockPath, lockPath, 'the timeout must name the exact mutex path');
        assert.equal(err.cause?.code, 'LOCK_HELD', 'the LOCK_HELD cause must be preserved');
        return true;
      },
    );
  } finally {
    stderr.restore();
  }
  // [0] => initial attempt + exactly ONE bounded retry, then the typed timeout.
  assert.deepEqual(lockAttempts, [lockPath, lockPath]);
  assert.equal(spawnCalls, 0, 'a held mutex must reject admission BEFORE spawn');
  assert.doesNotMatch(
    stderr.text(),
    /v2 session store unavailable|v2 session rollback failed/,
    `typed lock timeouts must throw, never degrade to the warning/null contract, got: ${stderr.text()}`,
  );
}));

test('a corrupt canonical .inventory.json rejects CODER_SESSION_STORE_INVALID before spawn and stays byte-identical', withRunEnv(async (base) => {
  const inventoryDir = sessionInventoryPath(join(base, '.triss'), 'opencode');
  mkdirSync(inventoryDir, { recursive: true });
  const corruptText = '{"schema_version":1,"entries":broken\n';
  writeFileSync(join(inventoryDir, INVENTORY_BASENAME), corruptText);
  let spawnCalls = 0;
  const stderr = captureStderr();
  try {
    await assert.rejects(
      () =>
        runCoderRun('do something', { session: 'store-invalid-proof' }, {
          spawn: () => {
            spawnCalls += 1;
            return spawnReplaying('', { code: 1 })();
          },
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
          stdoutWrite: () => true,
        }),
      (err) => {
        assert.equal(err.code, 'CODER_SESSION_STORE_INVALID');
        assert.match(err.message, /unreadable \(fail closed\)/);
        assert.equal(err.inventoryDir, inventoryDir);
        return true;
      },
    );
  } finally {
    stderr.restore();
  }
  assert.equal(spawnCalls, 0, 'a corrupt store must reject admission BEFORE spawn');
  // Fail closed means NO mutation: an undecodable document is never deleted,
  // overwritten, or "repaired" by a rollback that cannot know the state.
  assert.equal(
    readFileSync(join(inventoryDir, INVENTORY_BASENAME), 'utf8'),
    corruptText,
    'the corrupt document must be left byte-identical',
  );
  assert.doesNotMatch(
    stderr.text(),
    /v2 session store unavailable|v2 session rollback failed/,
    `typed store refusals must throw, never degrade to the warning/null contract, got: ${stderr.text()}`,
  );
}));

test('a parent-directory fsync failure AFTER rename rejects CODER_SESSION_DURABILITY_UNKNOWN and keeps the published reserved row recoverable', withRunEnv(async (base) => {
  const inventoryDir = sessionInventoryPath(join(base, '.triss'), 'opencode');
  let directoryFsyncAttempts = 0;
  // Real temp-file open/write/fsync/close and real rename/unlink; ONLY the
  // open of the exact inventoryDir for the parent fsync gets a wrapper whose
  // sync() throws while close() still closes the REAL directory handle.
  const inventoryFs = {
    open: async (path, flags, mode) => {
      const real = await fsOpen(path, flags, mode);
      if (flags === 'r' && path === inventoryDir) {
        directoryFsyncAttempts += 1;
        return {
          sync: () => {
            throw new Error('forced directory fsync failure');
          },
          close: () => real.close(),
        };
      }
      return real;
    },
    rename: (...args) => fsRename(...args),
    unlink: (...args) => fsUnlink(...args),
  };
  let spawnCalls = 0;
  const stderr = captureStderr();
  try {
    await assert.rejects(
      () =>
        runCoderRun('do something', { session: 'durability-proof' }, {
          spawn: () => {
            spawnCalls += 1;
            return spawnReplaying('', { code: 1 })();
          },
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
          stdoutWrite: () => true,
          sessionAdmission: { inventoryFs },
        }),
      (err) => {
        assert.equal(err.code, 'CODER_SESSION_DURABILITY_UNKNOWN');
        assert.equal(
          err.publicationMayHaveOccurred,
          true,
          'post-rename failures must carry publicationMayHaveOccurred=true',
        );
        assert.equal(err.inventoryDir, inventoryDir);
        assert.match(err.message, /rename succeeded but durability is unknown/);
        assert.equal(err.cause?.message, 'forced directory fsync failure');
        return true;
      },
    );
  } finally {
    stderr.restore();
  }
  // Exactly one publication was attempted (the claim); mark-running never ran.
  assert.equal(directoryFsyncAttempts, 1, 'only the claim publication may reach the directory fsync');
  assert.equal(spawnCalls, 0, 'durability-unknown must reject admission BEFORE spawn');
  assert.doesNotMatch(
    stderr.text(),
    /v2 session store unavailable|v2 session rollback failed/,
    `durability-unknown must throw, never degrade to the warning/null contract, got: ${stderr.text()}`,
  );
  // Rename already succeeded: the reserved row IS (or may be) published, so
  // no rollback may assume absence — it must remain visible for recovery.
  const after = await readCoderSessionInventory(inventoryDir);
  assert.equal(after.entries.length, 1, 'the published row must survive for recovery');
  assert.equal(after.entries[0].engine, 'opencode');
  assert.equal(after.entries[0].slug, 'durability-proof');
  assert.equal(after.entries[0].state, 'reserved', 'the recoverable row stays exactly as published');
  // The rename consumed the staged temp; only the canonical document remains.
  const remaining = await fsReaddir(inventoryDir);
  assert.deepEqual(remaining.sort(), ['.inventory.json'], 'no leftover temp files beside the published document');
}));

// ─── finalization seam: success-path completion failures (deps.sessionFinalization) ───
//
// completeV2SessionRow forwards acquireLock/lockRetryMs/inventoryFs into the
// REAL markCoderSessionIdle with the exact handle, so a success-path
// completion failure is exercised through production code, not mocks: the
// typed CODER_SESSION_FINALIZATION_FAILED error must reach the caller with
// its cause preserved, the success envelope must never reach stdout
// (finalization happens BEFORE stdout), the error stays out of ordinary
// abandon, and the row remains exactly as the failed transition left it.

test('a mutex held through finalization rejects CODER_SESSION_FINALIZATION_FAILED and keeps the row running', withRunEnv(async (base) => {
  const inventoryDir = sessionInventoryPath(join(base, '.triss'), 'opencode');
  const lockPath = join(inventoryDir, INVENTORY_LOCK_BASENAME);
  const streamText =
    JSON.stringify({ type: 'text', part: { text: 'done' } }) + '\n' +
    JSON.stringify({ type: 'step_finish', reason: 'stop' }) + '\n';
  const lockAttempts = [];
  const stdoutChunks = [];
  let spawnCalls = 0;
  let capturedHandle = null;
  const stderr = captureStderr();
  try {
    await assert.rejects(
      () =>
        runCoderRun('do something', { session: 'final-lock-proof' }, {
          spawn: () => {
            spawnCalls += 1;
            return spawnReplaying(streamText, { code: 0 })(); // engine SUCCEEDS
          },
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
          stdoutWrite: (s) => {
            stdoutChunks.push(String(s));
            return true;
          },
          sessionFinalization: {
            acquireLock: (path) => {
              lockAttempts.push(path);
              const err = new Error('forced finalization lock contention');
              err.code = 'LOCK_HELD';
              throw err;
            },
            lockRetryMs: [0],
          },
        }),
      (err) => {
        assert.equal(err.code, 'CODER_SESSION_FINALIZATION_FAILED');
        assert.match(err.message, /v2 session finalization failed for opencode\/final-lock-proof/);
        assert.equal(err.cause?.code, 'CODER_SESSION_LOCK_TIMEOUT', 'the store failure stays attached as cause');
        assert.equal(err.cause?.lockPath, lockPath);
        assert.equal(err.cause?.cause?.code, 'LOCK_HELD', 'the LOCK_HELD cause must be preserved');
        // The exact non-secret lifecycle handle rides along for recovery.
        capturedHandle = err.coderSessionHandle;
        assert.deepEqual(
          {
            inventoryDir: err.coderSessionHandle?.inventoryDir,
            engine: err.coderSessionHandle?.engine,
            slug: err.coderSessionHandle?.slug,
          },
          { inventoryDir, engine: 'opencode', slug: 'final-lock-proof' },
        );
        return true;
      },
    );
  } finally {
    stderr.restore();
  }
  // [0] => initial attempt + exactly ONE bounded retry, then the typed timeout.
  assert.deepEqual(lockAttempts, [lockPath, lockPath], 'the seam must reach the real mark-idle transition');
  assert.equal(spawnCalls, 1, 'the engine itself ran successfully');
  assert.equal(
    stdoutChunks.join(''),
    '',
    'finalization runs BEFORE stdout: no success envelope may be emitted',
  );
  assert.doesNotMatch(
    stderr.text(),
    /v2 session store unavailable|v2 session rollback failed/,
    `typed finalization failures must throw, never degrade or abandon, got: ${stderr.text()}`,
  );
  const after = await readCoderSessionInventory(inventoryDir);
  assert.equal(after.entries.length, 1, 'exactly one row exists');
  const row = after.entries[0];
  assert.equal(row.state, 'running', 'the row remains exactly as the failed transition left it');
  assert.equal(row.slug, 'final-lock-proof');
  assert.ok(row.run_id && row.pid, 'the running row still claims its live owner tuple');
  // The attached handle is the EXACT persisted owner tuple, so recovery can
  // lawfully act on the stranded row.
  assert.deepEqual(
    {
      runId: capturedHandle?.runId,
      sandboxId: capturedHandle?.sandboxId,
      pid: capturedHandle?.pid,
      processStartId: capturedHandle?.processStartId,
      bootId: capturedHandle?.bootId,
    },
    {
      runId: row.run_id,
      sandboxId: row.sandbox_id,
      pid: row.pid,
      processStartId: row.process_start_id,
      bootId: row.boot_id,
    },
  );
}));

test('a durability-unknown idle publication publishes the idle row yet fails the run without success stdout', withRunEnv(async (base) => {
  const inventoryDir = sessionInventoryPath(join(base, '.triss'), 'opencode');
  const streamText =
    JSON.stringify({ type: 'text', part: { text: 'done' } }) + '\n' +
    JSON.stringify({ type: 'step_finish', reason: 'stop' }) + '\n';
  let directoryFsyncAttempts = 0;
  // Wraps ONLY the finalization write: open of the exact inventoryDir as a
  // directory returns a handle whose sync() throws while close() still
  // closes the REAL directory handle; everything else delegates to the real
  // fs (temp-file write/fsync/rename all genuinely happen).
  const inventoryFs = {
    open: async (path, flags, mode) => {
      const real = await fsOpen(path, flags, mode);
      if (flags === 'r' && path === inventoryDir) {
        directoryFsyncAttempts += 1;
        return {
          sync: () => {
            throw new Error('forced directory fsync failure');
          },
          close: () => real.close(),
        };
      }
      return real;
    },
    rename: (...args) => fsRename(...args),
    unlink: (...args) => fsUnlink(...args),
  };
  const stdoutChunks = [];
  const stderr = captureStderr();
  try {
    await assert.rejects(
      () =>
        runCoderRun('do something', { session: 'final-durability-proof' }, {
          spawn: spawnReplaying(streamText, { code: 0 }), // engine SUCCEEDS
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
          stdoutWrite: (s) => {
            stdoutChunks.push(String(s));
            return true;
          },
          sessionFinalization: { inventoryFs },
        }),
      (err) => {
        assert.equal(err.code, 'CODER_SESSION_FINALIZATION_FAILED');
        assert.equal(err.cause?.code, 'CODER_SESSION_DURABILITY_UNKNOWN');
        assert.equal(
          err.cause?.publicationMayHaveOccurred,
          true,
          'post-rename failures must carry publicationMayHaveOccurred=true',
        );
        assert.equal(err.cause?.inventoryDir, inventoryDir);
        assert.match(err.cause?.message, /rename succeeded but durability is unknown/);
        assert.equal(err.cause?.cause?.message, 'forced directory fsync failure');
        return true;
      },
    );
  } finally {
    stderr.restore();
  }
  assert.equal(directoryFsyncAttempts, 1, 'only the idle publication reached the wrapped directory fsync');
  assert.equal(stdoutChunks.join(''), '', 'the run must fail because durability was unconfirmed — no success stdout');
  assert.doesNotMatch(
    stderr.text(),
    /v2 session rollback failed/,
    'typed finalization failures stay out of abandon — no rollback warning',
  );
  // The rename ALREADY succeeded: the published idle row is real and must be
  // readable from disk even though the command correctly failed.
  const after = await readCoderSessionInventory(inventoryDir);
  assert.equal(after.entries.length, 1, 'the published row survives');
  assert.equal(after.entries[0].engine, 'opencode');
  assert.equal(after.entries[0].slug, 'final-durability-proof');
  assert.equal(after.entries[0].state, 'idle', 'the idle rename landed before the fsync failed');
}));

test('rollback contending with a genuinely held lock throws CODER_SESSION_ROLLBACK_FAILED preserving both errors', withRunEnv(async (base) => {
  const inventoryDir = sessionInventoryPath(join(base, '.triss'), 'opencode');
  const lockPath = join(inventoryDir, INVENTORY_LOCK_BASENAME);
  const stdoutChunks = [];
  let lock = null;
  const stderr = captureStderr();
  try {
    await assert.rejects(
      () =>
        runCoderRun('do something', { session: 'rollback-lock-proof' }, {
          spawn: () => {
            // Reservation happened BEFORE spawn — grab the REAL inventory
            // mutex now so the post-failure rollback exhausts its whole
            // bounded retry schedule against a genuinely held lock.
            lock = acquireCoderMutationLock('engine-sessions', 'inventory', { lockPath });
            return spawnReplaying('', { code: 1 })(); // zero parseable output -> throw
          },
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
          stdoutWrite: (s) => {
            stdoutChunks.push(String(s));
            return true;
          },
        }),
      (err) => {
        assert.equal(err.code, 'CODER_SESSION_ROLLBACK_FAILED');
        assert.ok(err instanceof AggregateError, 'both errors are preserved in an AggregateError');
        assert.equal(err.errors.length, 2, 'engine error AND rollback error stay reachable');
        assert.match(
          err.engineError?.message,
          /produced no parseable output/,
          'errors[0] is still the ORIGINAL engine failure',
        );
        assert.equal(err.rollbackError?.code, 'CODER_SESSION_LOCK_TIMEOUT');
        assert.equal(err.rollbackError?.lockPath, lockPath);
        assert.equal(err.rollbackError?.cause?.code, 'LOCK_HELD');
        assert.equal(err.coderSessionHandle?.slug, 'rollback-lock-proof');
        return true;
      },
    );
  } finally {
    if (lock) lock.release();
    stderr.restore();
  }
  assert.equal(stdoutChunks.join(''), '', 'a doubly-failed run emits no success stdout');
  // The delete transition died on the mutex BEFORE mutating anything: the
  // live row keeps claiming the slug until explicit recovery/reconcile.
  const after = await readCoderSessionInventory(inventoryDir);
  assert.equal(after.entries.length, 1, 'the stranded row survives for explicit recovery');
  assert.equal(after.entries[0].slug, 'rollback-lock-proof');
  assert.ok(
    after.entries[0].state === 'running' || after.entries[0].state === 'reserved',
    `the row remains running/reserved for recovery, got ${after.entries[0].state}`,
  );
}));
