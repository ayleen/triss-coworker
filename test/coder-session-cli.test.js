/**
 * coder-session-cli.test.js — CLI expectation
 * adapter / v2 session CLI.
 *
 * RED/GREEN: node --test test/coder-session-cli.test.js
 *
 * Covers the v2 session CLI contract of docs/reliable-delegation-contract-plan.md
 * (transition): per-engine inventory list/clean, the mandatory engine flag,
 * idle-only clean, retained-result list/clean validation, and legacy-map
 * immunity (the shared .triss/sessions.json map never selects or cleans a v2
 * session).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reserveCoderSession, markCoderSessionRunning, markCoderSessionIdle } from '../src/coder-session-transitions.js';
import { processStartIdentity } from '../src/update/cache.js';
import { readCoderSessionInventory } from '../src/coder-session-inventory-codec.js';
import { writeResultState } from '../src/coder-result-registry-codec.js';
import {
  completeV2SessionRow,
  currentBootIdentity,
  currentSessionOwnerTuple,
  releaseV2SessionRow,
  reserveV2SessionRow,
  revalidateV2SessionRowBeforeSpawn,
  runCoderSessionClean,
  runCoderResultClean,
} from '../src/commands/coder.js';

const FP = 'f'.repeat(64);
const NOW = '2026-08-13T10:00:00.000Z';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-session-cli-'));
  // Real layout: .triss/engine-sessions-v2/<engine> (per-engine v2 store).
  const inventoryDir = join(base, '.triss', 'engine-sessions-v2', 'opencode');
  await mkdir(inventoryDir, { mode: 0o700, recursive: true });
  await mkdir(join(base, '.triss', 'engine-sessions-v2', 'crush'), { mode: 0o700, recursive: true });
  return {
    base,
    inventoryDir,
    crushDir: join(base, '.triss', 'engine-sessions-v2', 'crush'),
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function seedSession(fx, engine, slug, { idle = true } = {}) {
  const dir = engine === 'crush' ? fx.crushDir : fx.inventoryDir;
  await reserveCoderSession({
    inventoryDir: dir,
    engine,
    slug,
    isolationMode: 'isolated',
    lockSlot: 0,
    projectRootFingerprint: FP,
    runId: `run-${slug}`,
    pid: 100,
    processStartId: 'ps-1',
    bootId: 'boot-1',
  });
  if (idle) {
    await markCoderSessionRunning({
      inventoryDir: dir,
      engine,
      slug,
      runId: `run-${slug}`,
      pid: 100,
      processStartId: 'ps-1',
      bootId: 'boot-1',
    });
    await markCoderSessionIdle({ inventoryDir: dir, engine, slug });
  }
}

test('production reservation publishes a complete current-process owner tuple', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const session = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'production-owner',
      isolated: false,
      ownerTuple: {
        pid: 321,
        processStartId: 'ps-production',
        bootId: 'boot-production',
      },
    });
    assert.ok(session);
    // Admission leaves the row RESERVED with the complete claimed tuple; the
    // pre-spawn revalidation performs reserved -> running under the leases.
    const inventoryDir = join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2');
    const reserved = await readCoderSessionInventory(inventoryDir);
    assert.equal(reserved.entries.length, 1);
    assert.equal(reserved.entries[0].state, 'reserved');
    assert.equal(reserved.entries[0].pid, 321);
    assert.equal(reserved.entries[0].process_start_id, 'ps-production');
    assert.equal(reserved.entries[0].boot_id, 'boot-production');
    assert.notEqual(reserved.entries[0].sandbox_id, null);
    await revalidateV2SessionRowBeforeSpawn(session);
    const running = await readCoderSessionInventory(inventoryDir);
    assert.equal(running.entries[0].state, 'running');
    assert.equal(running.entries[0].pid, 321);
    // Success finalizer: running -> idle AND the held slot lease is released
    // (the next admission in this test must not block on our own marker).
    await completeV2SessionRow(session);
    const completed = await readCoderSessionInventory(inventoryDir);
    assert.equal(completed.entries[0].state, 'idle');
    assert.equal(completed.entries[0].pid, null);
    const resumed = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'production-owner',
      isolated: false,
      ownerTuple: {
        pid: 654,
        processStartId: 'ps-resumed',
        bootId: 'boot-resumed',
      },
    });
    assert.ok(resumed);
    // A continuation of an idle row claims it as running AT admission.
    assert.equal(resumed.origin, 'idle_continuation');
    const resumedInventory = await readCoderSessionInventory(inventoryDir);
    assert.equal(resumedInventory.entries.length, 1);
    assert.equal(resumedInventory.entries[0].state, 'running');
    assert.equal(resumedInventory.entries[0].pid, 654);
    assert.equal(resumedInventory.entries[0].process_start_id, 'ps-resumed');
    assert.equal(resumedInventory.entries[0].boot_id, 'boot-resumed');
    // Provenance-aware rollback: a FAILED continuation returns the published
    // session to idle (never deletes it) and clears the new owner tuple.
    await releaseV2SessionRow(resumed);
    const rolledBack = await readCoderSessionInventory(inventoryDir);
    assert.equal(rolledBack.entries.length, 1);
    assert.equal(rolledBack.entries[0].state, 'idle');
    assert.equal(rolledBack.entries[0].run_id, null);
    assert.equal(rolledBack.entries[0].sandbox_id, null);
    assert.equal(rolledBack.entries[0].pid, null);
    assert.equal(rolledBack.entries[0].process_start_id, null);
    assert.equal(rolledBack.entries[0].boot_id, null);
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('current owner helpers produce stable host identities and reject missing evidence', () => {
  assert.equal(
    currentBootIdentity({
      platform: 'linux',
      readFile: () => '12345678-1234-1234-1234-123456789abc\n',
    }),
    'linux:12345678-1234-1234-1234-123456789abc',
  );
  assert.equal(
    currentBootIdentity({
      platform: 'darwin',
      spawnSync: () => ({ status: 0, stdout: '{ sec = 12345, usec = 67 } Mon Aug 1' }),
    }),
    'darwin:12345:67',
  );
  assert.deepEqual(
    currentSessionOwnerTuple({ pid: 12, processStartId: 'ps-12', bootId: 'boot-12' }),
    { pid: 12, processStartId: 'ps-12', bootId: 'boot-12' },
  );
  assert.throws(
    () => currentSessionOwnerTuple({ pid: 12, processStartId: '', bootId: 'boot-12' }),
    /owner identity is unavailable/,
  );
});

// runCoderSessionList/runCoderSessionClean use projectRoot() from the triss
// environment; the session run functions take explicit inventoryDir, so we
// test the underlying transitions + the CLI validation surface here.

// ─── Fix 1: host identity probes never leak the parent environment ─────────

test('host identity probes use absolute binaries and a minimal fixed environment', () => {
  const SENTINEL = 'TRISS_TEST_SENTINEL_CREDENTIAL';
  const originalSentinel = process.env[SENTINEL];
  process.env[SENTINEL] = 'super-secret-credential-value';
  try {
    let psCall = null;
    const identity = processStartIdentity(4242, {
      readProc: () => { throw new Error('no procfs in test'); },
      execPs: (file, args, opts) => { psCall = { file, args, opts }; return 'Mon Jan  1 00:00:00 2026'; },
    });
    assert.equal(identity, 'ps:Mon Jan 1 00:00:00 2026');
    assert.equal(psCall.file, '/bin/ps', 'ps must be invoked by its absolute path');
    assert.deepEqual(psCall.args, ['-o', 'lstart=', '-p', '4242']);
    assert.equal(psCall.opts.env[SENTINEL], undefined, 'parent credentials must never reach the child env');
    assert.equal(psCall.opts.env.PATH, undefined, 'no parent PATH may be forwarded');
    assert.equal(psCall.opts.env.LC_ALL, 'C');
    assert.equal(psCall.opts.env.TZ, 'UTC');

    let bootCall = null;
    const boot = currentBootIdentity({
      platform: 'darwin',
      spawnSync: (file, args, opts) => { bootCall = { file, args, opts }; return { status: 0, stdout: '{ sec = 111, usec = 222 } x' }; },
    });
    assert.equal(boot, 'darwin:111:222');
    assert.equal(bootCall.file, '/usr/sbin/sysctl', 'sysctl must be invoked by its absolute path');
    assert.equal(bootCall.opts.env[SENTINEL], undefined, 'parent credentials must never reach the child env');
    assert.equal(bootCall.opts.env.PATH, undefined, 'no parent PATH may be forwarded');
    assert.equal(bootCall.opts.env.LC_ALL, 'C');
  } finally {
    if (originalSentinel === undefined) delete process.env[SENTINEL];
    else process.env[SENTINEL] = originalSentinel;
  }
});

// ─── Fixes 2+4+5: provenance-aware lifecycle under the leases ──────────────

async function realProjectFingerprint(base) {
  const { loadOrCreateProjectIdentity, projectRootFingerprint } = await import('../src/coder-state.js');
  const trissRoot = join(base, '.triss');
  const identity = await loadOrCreateProjectIdentity(trissRoot);
  return projectRootFingerprint(identity.project_id);
}

async function seedIdleRow(fx, engine, slug, { isolationMode = 'isolated', fingerprint = FP } = {}) {
  const dir = engine === 'crush' ? fx.crushDir : join(fx.base, '.triss', 'engine-sessions-v2', engine);
  await mkdir(dir, { mode: 0o700, recursive: true });
  await reserveCoderSession({
    inventoryDir: dir,
    engine,
    slug,
    isolationMode,
    lockSlot: 0,
    projectRootFingerprint: fingerprint,
    runId: `run-${slug}`,
    pid: 100,
    processStartId: 'ps-seed',
    bootId: 'boot-seed',
  });
  await markCoderSessionRunning({
    inventoryDir: dir,
    engine,
    slug,
    runId: `run-${slug}`,
    pid: 100,
    processStartId: 'ps-seed',
    bootId: 'boot-seed',
  });
  await markCoderSessionIdle({ inventoryDir: dir, engine, slug });
}

test('rollback of a NEW reservation removes the row this run created', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const session = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'fresh-row',
      isolated: false,
      ownerTuple: { pid: 41, processStartId: 'ps-a', bootId: 'boot-a' },
    });
    assert.equal(session.origin, 'new_reservation');
    const inventoryDir = join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2');
    const before = await readCoderSessionInventory(inventoryDir);
    assert.equal(before.entries[0].state, 'reserved');
    await releaseV2SessionRow(session);
    const after = await readCoderSessionInventory(inventoryDir);
    assert.equal(after.entries.length, 0, 'the unpublished reservation must be removed');
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('a live same-slug row rejects admission with TRISS_CODER_SESSION_BUSY instead of downgrading', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    // A crash mid-run leaves a RUNNING row: admission must fail closed.
    const dir = join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2');
    await mkdir(dir, { mode: 0o700, recursive: true });
    await reserveCoderSession({
      inventoryDir: dir,
      engine: 'opencode2',
      slug: 'live-row',
      isolationMode: 'non_isolated',
      lockSlot: 0,
      projectRootFingerprint: FP,
      runId: 'run-live',
      pid: 4242,
      processStartId: 'ps-live',
      bootId: 'boot-live',
    });
    await assert.rejects(
      () => reserveV2SessionRow({
        engine: 'opencode2',
        slug: 'live-row',
        isolated: false,
        ownerTuple: { pid: process.pid, processStartId: 'ps-current', bootId: 'boot-current' },
      }),
      (err) => err?.code === 'TRISS_CODER_SESSION_BUSY' && /is (running|reserved)/.test(err.message),
    );
    // The foreign row is retained untouched (retain, fail closed).
    const after = await readCoderSessionInventory(dir);
    assert.equal(after.entries.length, 1);
    assert.equal(after.entries[0].run_id, 'run-live');
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('continuation rejects an isolation-mode change in BOTH directions', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    // Persisted isolated row, requested non-isolated.
    await seedIdleRow(fx, 'opencode2', 'iso-a', { isolationMode: 'isolated' });
    await assert.rejects(
      () => reserveV2SessionRow({
        engine: 'opencode2',
        slug: 'iso-a',
        isolated: false,
        ownerTuple: { pid: process.pid, processStartId: 'ps-cur', bootId: 'boot-cur' },
      }),
      (err) => err?.code === 'TRISS_CODER_SESSION_INCOMPATIBLE' && /isolation_mode=isolated/.test(err.message),
    );
    // Persisted non-isolated row, requested isolated.
    await seedIdleRow(fx, 'opencode2', 'iso-b', { isolationMode: 'non_isolated' });
    await assert.rejects(
      () => reserveV2SessionRow({
        engine: 'opencode2',
        slug: 'iso-b',
        isolated: true,
        ownerTuple: { pid: process.pid, processStartId: 'ps-cur', bootId: 'boot-cur' },
      }),
      (err) => err?.code === 'TRISS_CODER_SESSION_INCOMPATIBLE' && /isolation_mode=non_isolated/.test(err.message),
    );
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('a same-mode continuation with matching ownership succeeds and rolls back to idle', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const fingerprint = await realProjectFingerprint(fx.base);
    await seedIdleRow(fx, 'opencode2', 'same-mode', { isolationMode: 'non_isolated', fingerprint });
    const resumed = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'same-mode',
      isolated: false,
      ownerTuple: { pid: 91, processStartId: 'ps-resume', bootId: 'boot-resume' },
    });
    assert.equal(resumed.origin, 'idle_continuation');
    await releaseV2SessionRow(resumed);
    const dir = join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2');
    const after = await readCoderSessionInventory(dir);
    assert.equal(after.entries[0].state, 'idle');
    assert.equal(after.entries[0].pid, null);
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('a continuation whose project identity differs fails closed', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    // Seeded with a foreign project fingerprint; isolation mode MATCHES the
    // request so the fingerprint gate is what must reject.
    await seedIdleRow(fx, 'opencode2', 'foreign-fp', { isolationMode: 'non_isolated', fingerprint: FP });
    await assert.rejects(
      () => reserveV2SessionRow({
        engine: 'opencode2',
        slug: 'foreign-fp',
        isolated: false,
        ownerTuple: { pid: process.pid, processStartId: 'ps-cur', bootId: 'boot-cur' },
      }),
      (err) => err?.code === 'TRISS_CODER_SESSION_INCOMPATIBLE' && /different project identity/.test(err.message),
    );
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('session clean removes an opencode2 row end-to-end and clears only its own artifacts', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    // Named production run -> idle row (the exact lifecycle the PR adds).
    const session = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'e2clean',
      isolated: false,
      ownerTuple: { pid: 71, processStartId: 'ps-e2', bootId: 'boot-e2' },
    });
    await revalidateV2SessionRowBeforeSpawn(session);
    await completeV2SessionRow(session);
    // Same slug in the NEIGHBORING engine plus a versioned-store mapping
    // for both engines: clean must touch ONLY its own engine.
    await seedSession(fx, 'opencode', 'e2clean');
    await writeFile(
      join(fx.base, '.triss', 'sessions.json'),
      JSON.stringify({ version: 2, engines: { opencode: { e2clean: 'ses_v1id' }, opencode2: { e2clean: 'ses_v2realid' } } }),
      { mode: 0o600 },
    );
    await runCoderSessionClean('e2clean', { engine: 'opencode2' });
    const oc2 = await readCoderSessionInventory(join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2'));
    assert.equal(oc2.entries.length, 0, 'the opencode2 row must be gone');
    const v1 = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(v1.entries.length, 1, 'the same-slug opencode row must survive');
    assert.equal(v1.entries[0].slug, 'e2clean');
    const { readFile } = await import('node:fs/promises');
    const store = JSON.parse(await readFile(join(fx.base, '.triss', 'sessions.json'), 'utf8'));
    assert.equal(store.engines.opencode2.e2clean, undefined, 'engine-owned store mapping must be cleared');
    assert.equal(store.engines.opencode.e2clean, 'ses_v1id', 'other engine namespace untouched');
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('crush rows are cleanable without a store namespace', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    await seedSession(fx, 'crush', 'crushy');
    await runCoderSessionClean('crushy', { engine: 'crush' });
    const crush = await readCoderSessionInventory(fx.crushDir);
    assert.equal(crush.entries.length, 0);
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

// ─── Fix 4: admission/concurrency barriers ─────────────────────────────────

// Auto-release a winner's slot lease so a blocked loser admission can make
// progress without deadlocking the test process.
function autoReleaseLease(promise) {
  return promise.then((session) => {
    setTimeout(() => { Promise.resolve(session.releaseRunLease?.()).catch(() => {}); }, 150);
    return session;
  });
}

test('simultaneous same-slug admissions serialize: exactly one wins, the loser gets TRISS_CODER_SESSION_BUSY', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const outcomes = await Promise.allSettled([
      autoReleaseLease(reserveV2SessionRow({
        engine: 'opencode2',
        slug: 'race-same',
        isolated: false,
        ownerTuple: { pid: 81, processStartId: 'ps-r1', bootId: 'boot-r1' },
      })),
      autoReleaseLease(reserveV2SessionRow({
        engine: 'opencode2',
        slug: 'race-same',
        isolated: false,
        ownerTuple: { pid: 82, processStartId: 'ps-r2', bootId: 'boot-r2' },
      })),
    ]);
    const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
    const rejected = outcomes.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one admission may win');
    assert.equal(rejected.length, 1, 'the loser must fail closed, never downgrade');
    assert.equal(rejected[0].reason?.code, 'TRISS_CODER_SESSION_BUSY');
    // The canonical inventory holds exactly ONE live row owned by the winner.
    const dir = join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2');
    const inv = await readCoderSessionInventory(dir);
    assert.equal(inv.entries.length, 1);
    assert.equal(inv.entries[0].state, 'reserved');
    const winnerPid = fulfilled[0].value.pid;
    assert.ok([81, 82].includes(winnerPid));
    assert.equal(inv.entries[0].pid, winnerPid);
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('two different slugs admitted concurrently both survive with distinct lock slots (no lost update)', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const outcomes = await Promise.allSettled([
      autoReleaseLease(reserveV2SessionRow({
        engine: 'opencode2',
        slug: 'par-a',
        isolated: false,
        ownerTuple: { pid: 83, processStartId: 'ps-pa', bootId: 'boot-pa' },
      })),
      autoReleaseLease(reserveV2SessionRow({
        engine: 'opencode2',
        slug: 'par-b',
        isolated: false,
        ownerTuple: { pid: 84, processStartId: 'ps-pb', bootId: 'boot-pb' },
      })),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') throw outcome.reason;
    }
    const dir = join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2');
    const inv = await readCoderSessionInventory(dir);
    assert.equal(inv.entries.length, 2, 'both rows must exist — a lost update would leave one');
    const slugs = inv.entries.map((e) => e.slug).sort();
    assert.deepEqual(slugs, ['par-a', 'par-b']);
    const slots = new Set(inv.entries.map((e) => e.lock_slot));
    assert.equal(slots.size, 2, 'live rows must hold distinct slots');
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

// ─── session list ────────────────────────────────────────────────────────────

test('per-engine inventory lists only the selected engine rows', async () => {
  const fx = await fixture();
  try {
    await seedSession(fx, 'opencode', 'task-a');
    await seedSession(fx, 'crush', 'task-a'); // same slug, different engine
    const opencode = await readCoderSessionInventory(fx.inventoryDir);
    const crush = await readCoderSessionInventory(fx.crushDir);
    assert.equal(opencode.entries.length, 1);
    assert.equal(crush.entries.length, 1);
    // Same slug across engines is deduplicated per engine store.
    assert.equal(opencode.entries[0].slug, 'task-a');
    assert.equal(crush.entries[0].slug, 'task-a');
  } finally {
    await fx.cleanup();
  }
});

test('a legacy shared .triss/sessions.json map never selects a v2 session', async () => {
  const fx = await fixture();
  try {
    await seedSession(fx, 'opencode', 'task-a');
    // Legacy map with a DIFFERENT real engine id: the v2 inventory must not
    // see it (no shared map exists in v2).
    await writeFile(join(fx.base, '.triss', 'sessions.json'), JSON.stringify({ task_a: 'legacy-real-id' }), { mode: 0o600 });
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].slug, 'task-a');
    // The legacy file survives untouched.
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(join(fx.base, '.triss', 'sessions.json'), 'utf8'), JSON.stringify({ task_a: 'legacy-real-id' }));
  } finally {
    await fx.cleanup();
  }
});

// ─── session clean validation ────────────────────────────────────────────────

test('session clean requires the engine flag and rejects non-idle sessions', async () => {
  const fx = await fixture();
  try {
    await seedSession(fx, 'opencode', 'task-a', { idle: false }); // still running
    await assert.rejects(
      () => runCoderSessionClean('task-a', {}),
      (err) => err?.message === '--engine <opencode|opencode2|crush> is required for session clean',
    );
    // Unknown engine names fail closed on the canonical enum.
    await assert.rejects(
      () => runCoderSessionClean('task-a', { engine: 'gemini' }),
      /--engine <opencode\|opencode2\|crush> is required/,
    );
    // Engine flag present but the row is not idle: rejected.
    const originalRoot = process.env.TRISS_PROJECT_ROOT;
    process.env.TRISS_PROJECT_ROOT = fx.base;
    try {
      await assert.rejects(
        () => runCoderSessionClean('task-a', { engine: 'opencode' }),
        /not idle/,
      );
    } finally {
      if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = originalRoot;
    }
  } finally {
    await fx.cleanup();
  }
});

// ─── result list / clean ─────────────────────────────────────────────────────

test('result clean validates the run-id grammar and never accepts a slug', async () => {
  await assert.rejects(() => runCoderResultClean('task-a', {}), /run-<32 lowercase hex>/);
  await assert.rejects(() => runCoderResultClean('', {}), /run-<32 lowercase hex>/);
  await assert.rejects(() => runCoderResultClean(null, {}), /run-<32 lowercase hex>/);
  // Invariant: a valid run id whose artifact is ABSENT fails closed — clean is
  // a state-machine delete over a validated registry entry, never a blind
  // no-op rm.
  await assert.rejects(
    () => runCoderResultClean('run-'.concat('a'.repeat(32)), {}),
    /not found/,
  );
});

test('result-state records persist and list under the runs root', async () => {
  const fx = await fixture();
  try {
    const runsRoot = join(fx.base, '.triss', 'coder-results-v1', 'runs', 'run-abc123');
    await mkdir(runsRoot, { recursive: true });
    const record = {
      schema_version: 1,
      kind: 'result',
      run_id: 'run-abc123',
      engine: 'opencode',
      session_slug: 'task-a',
      project_root_fingerprint: FP,
      branch_ref: `refs/heads/coder-result-v1/${FP}/opencode/run-abc123`,
      repository_object_format: 'sha1',
      base_commit_oid: 'a'.repeat(40),
      repository_fingerprint: `sha256:${'b'.repeat(64)}`,
      worktree_parent_realpath: runsRoot,
      worktree_basename: 'worktree',
      worktree_fingerprint: `sha256:${'c'.repeat(64)}`,
      base_snapshot_id: `sha256:${'d'.repeat(64)}`,
      post_snapshot_id: `sha256:${'e'.repeat(64)}`,
      source_coder_state_sha256: '0'.repeat(64),
      published_at: NOW,
    };
    await writeResultState(runsRoot, record);
    // The canonical record round-trips.
    const { readResultState } = await import('../src/coder-result-registry-codec.js');
    const loaded = await readResultState(runsRoot);
    assert.equal(loaded.run_id, 'run-abc123');
    assert.equal(loaded.session_slug, 'task-a');
  } finally {
    await fx.cleanup();
  }
});
