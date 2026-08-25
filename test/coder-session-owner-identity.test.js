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
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import { readCoderSessionInventory } from '../src/coder-session-inventory-codec.js';
import { sessionInventoryPath } from '../src/coder-session-transitions.js';
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
