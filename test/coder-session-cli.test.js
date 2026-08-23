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

import { beginCoderSessionDelete, markCoderSessionRunning, markCoderSessionIdle, reserveCoderSession } from '../src/coder-session-transitions.js';
import { processStartIdentity } from '../src/update/cache.js';
import { readCoderSessionInventory, RESERVED_BYTES } from '../src/coder-session-inventory-codec.js';
import { writeResultState } from '../src/coder-result-registry-codec.js';
import { acquireCoderTargetLease } from '../src/coder-lease.js';
import { openManagedTrissRoot } from '../src/managed-root.js';
import { acquireFixedKernelLock } from '../src/fixed-kernel-lock.js';
import {
  completeV2SessionRow,
  currentBootIdentity,
  currentSessionOwnerTuple,
  releaseV2SessionRow,
  removeSessionStoreMapping,
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
    // Production ordering: the engine's real id is durably published BEFORE
    // the envelope/completion; completion verifies it before going idle.
    await writeStoreMapping(fx.base, 'opencode2', 'production-owner', 'ses_prod_real');
    await completeV2SessionRow(session, 'ses_prod_real');
    // Success finalizer: running -> idle AND the held run lease is released
    // (the next admission in this test must not block on our own marker).
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

async function readStore(base) {
  const { readFile } = await import('node:fs/promises');
  try {
    return JSON.parse(await readFile(join(base, '.triss', 'sessions.json'), 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return { version: 2, engines: {} };
    throw err;
  }
}

async function writeStoreMapping(base, engine, slug, realId) {
  const store = await readStore(base);
  store.engines = store.engines || {};
  store.engines[engine] = store.engines[engine] || {};
  store.engines[engine][slug] = realId;
  await writeFile(join(base, '.triss', 'sessions.json'), JSON.stringify(store), { mode: 0o600 });
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
    // A continuation requires the durable published mapping.
    await writeStoreMapping(fx.base, 'opencode2', 'same-mode', 'ses_resumed_real');
    const resumed = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'same-mode',
      isolated: false,
      ownerTuple: { pid: 91, processStartId: 'ps-resume', bootId: 'boot-resume' },
    });
    assert.equal(resumed.origin, 'idle_continuation');
    assert.equal(resumed.resumedRealId, 'ses_resumed_real');
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
    await writeStoreMapping(fx.base, 'opencode2', 'e2clean', 'ses_v2realid');
    await completeV2SessionRow(session, 'ses_v2realid');
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

// ─── Round 2: store-mapping-driven lifecycle ───────────────────────────────

test('a failure AFTER the mapping was published keeps the session (row -> idle)', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const session = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'pub-fail',
      isolated: false,
      ownerTuple: { pid: 61, processStartId: 'ps-pf', bootId: 'boot-pf' },
    });
    // The engine finished and persistSessionMapping already ran; THEN the
    // envelope write throws. origin is still new_reservation, but the
    // durable mapping makes this a PUBLISHED session.
    await writeStoreMapping(fx.base, 'opencode2', 'pub-fail', 'ses_published');
    // Production anchored the publication on the session handle right after
    // persistSessionMapping — the finalizer recognizes ONLY that exact id.
    session.publishedRealId = 'ses_published';
    await releaseV2SessionRow(session);
    const inv = await readCoderSessionInventory(join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2'));
    assert.equal(inv.entries.length, 1, 'the published session must NOT be deleted');
    assert.equal(inv.entries[0].state, 'idle');
    assert.equal(inv.entries[0].pid, null);
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('a successful run without a resumable real id removes the unusable row', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const session = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'no-real-id',
      isolated: false,
      ownerTuple: { pid: 62, processStartId: 'ps-nr', bootId: 'boot-nr' },
    });
    await revalidateV2SessionRowBeforeSpawn(session);
    // Stream succeeded but NO event ever carried a sessionID: publishing
    // idle would make the next run silently start a fresh conversation.
    assert.equal(await completeV2SessionRow(session, null), 'removed_unusable');
    const inv = await readCoderSessionInventory(join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2'));
    assert.equal(inv.entries.length, 0, 'an unusable persistent row must be removed');
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('Crush completion retains the row when native id differs from its admitted slug', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const session = await reserveV2SessionRow({
      engine: 'crush',
      slug: 'crush-native-key',
      isolated: false,
      ownerTuple: { pid: 65, processStartId: 'ps-crush', bootId: 'boot-crush' },
    });
    await revalidateV2SessionRowBeforeSpawn(session);
    // Crush receives the slug itself as its native get-or-create key. A
    // different result id cannot be resumed through this admitted row.
    assert.equal(
      await completeV2SessionRow(session, 'foreign-native-id'),
      'retained_for_recovery',
    );
    const inv = await readCoderSessionInventory(fx.crushDir);
    assert.equal(inv.entries.length, 1, 'mismatch must retain the recovery row');
    assert.equal(inv.entries[0].state, 'running');
    assert.equal(inv.entries[0].pid, 65);
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('completion publishes idle only with the matching durable mapping', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const session = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'match-map',
      isolated: false,
      ownerTuple: { pid: 63, processStartId: 'ps-mm', bootId: 'boot-mm' },
    });
    await revalidateV2SessionRowBeforeSpawn(session);
    await writeStoreMapping(fx.base, 'opencode2', 'match-map', 'ses_match');
    assert.equal(await completeV2SessionRow(session, 'ses_match'), 'persistent');
    let inv = await readCoderSessionInventory(join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2'));
    assert.equal(inv.entries[0].state, 'idle');
    assert.equal(inv.entries[0].pid, null);
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('a mismatched mapping on completion retains the row (fail closed)', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const session = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'mis-map',
      isolated: false,
      ownerTuple: { pid: 64, processStartId: 'ps-x', bootId: 'boot-x' },
    });
    await revalidateV2SessionRowBeforeSpawn(session);
    await writeStoreMapping(fx.base, 'opencode2', 'mis-map', 'ses_other');
    assert.equal(await completeV2SessionRow(session, 'ses_expected'), 'retained_for_recovery');
    const inv = await readCoderSessionInventory(join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2'));
    assert.equal(inv.entries.length, 1, 'ambiguity retains the row');
    assert.equal(inv.entries[0].state, 'running');
    assert.equal(inv.entries[0].pid, 64);
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('completion surfaces an unresolved lease release and never authorizes a clean envelope', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const session = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'release-failure',
      isolated: false,
      ownerTuple: { pid: 66, processStartId: 'ps-release', bootId: 'boot-release' },
    });
    await revalidateV2SessionRowBeforeSpawn(session);
    await writeStoreMapping(fx.base, 'opencode2', 'release-failure', 'ses_release');
    const release = session.runLease.release;
    session.runLease.release = async () => { throw new Error('injected lease release failure'); };
    await assert.rejects(
      () => completeV2SessionRow(session, 'ses_release'),
      (err) => /run lease release failed/.test(err.message) && /injected lease release failure/.test(err.cause?.message),
    );
    const inv = await readCoderSessionInventory(join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2'));
    assert.equal(inv.entries[0].state, 'idle');
    session.runLease.release = release;
    await release();
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('completion retries a one-shot lease release failure and keeps persistent outcome', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const session = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'release-retry',
      isolated: false,
      ownerTuple: { pid: 67, processStartId: 'ps-release-retry', bootId: 'boot-release-retry' },
    });
    await revalidateV2SessionRowBeforeSpawn(session);
    await writeStoreMapping(fx.base, 'opencode2', 'release-retry', 'ses_release_retry');
    const release = session.runLease.release;
    let attempts = 0;
    session.runLease.release = async function oneShotRelease() {
      attempts += 1;
      if (attempts === 1) throw new Error('injected one-shot lease release failure');
      return release.call(this);
    };
    assert.equal(await completeV2SessionRow(session, 'ses_release_retry'), 'persistent');
    assert.equal(attempts, 2);
    session.runLease.release = release;

    const resumed = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'release-retry',
      isolated: false,
      ownerTuple: { pid: 68, processStartId: 'ps-release-retry-2', bootId: 'boot-release-retry-2' },
    });
    await resumed.releaseRunLease();
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('a continuation WITHOUT a published mapping is rejected before any claim', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const fingerprint = await realProjectFingerprint(fx.base);
    await seedIdleRow(fx, 'opencode2', 'no-map', { isolationMode: 'non_isolated', fingerprint });
    await assert.rejects(
      () => reserveV2SessionRow({
        engine: 'opencode2',
        slug: 'no-map',
        isolated: false,
        ownerTuple: { pid: process.pid, processStartId: 'ps-c', bootId: 'boot-c' },
      }),
      (err) => err?.code === 'TRISS_CODER_SESSION_INCOMPATIBLE' && /NO published session mapping/.test(err.message),
    );
    // The idle row is untouched by the rejected claim.
    const inv = await readCoderSessionInventory(join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2'));
    assert.equal(inv.entries[0].state, 'idle');
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

// ─── Round 2: crash-safe clean ordering + lease barriers ───────────────────

test('clean recovers a deleting breadcrumb idempotently (mapping still present)', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const fingerprint = await realProjectFingerprint(fx.base);
    await seedIdleRow(fx, 'opencode2', 'rec-a', { isolationMode: 'non_isolated', fingerprint });
    await writeStoreMapping(fx.base, 'opencode2', 'rec-a', 'ses_rec');
    // Simulate a crash AFTER idle -> deleting but BEFORE mapping removal.
    const dir = join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2');
    await beginCoderSessionDelete({
      inventoryDir: dir,
      engine: 'opencode2',
      slug: 'rec-a',
      runId: 'run_crashtest1',
      sandboxId: `sbx_${'d'.repeat(32)}`,
      pid: 555,
      processStartId: 'ps-crash',
      bootId: 'boot-crash',
    });
    await runCoderSessionClean('rec-a', { engine: 'opencode2' });
    const inv = await readCoderSessionInventory(dir);
    assert.equal(inv.entries.length, 0, 'the recovery pass must converge to removal');
    const store = await readStore(fx.base);
    assert.equal(store.engines.opencode2['rec-a'], undefined, 'mapping cleared by recovery');
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('clean recovers a deleting breadcrumb whose mapping is already gone', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const fingerprint = await realProjectFingerprint(fx.base);
    await seedIdleRow(fx, 'opencode2', 'rec-b', { isolationMode: 'non_isolated', fingerprint });
    const dir = join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2');
    await beginCoderSessionDelete({
      inventoryDir: dir,
      engine: 'opencode2',
      slug: 'rec-b',
      runId: 'run_crashtest2',
      sandboxId: `sbx_${'e'.repeat(32)}`,
      pid: 556,
      processStartId: 'ps-crash',
      bootId: 'boot-crash',
    });
    // Crash AFTER mapping removal, BEFORE row removal.
    await removeSessionStoreMapping('opencode2', 'rec-b');
    await runCoderSessionClean('rec-b', { engine: 'opencode2' });
    const inv = await readCoderSessionInventory(dir);
    assert.equal(inv.entries.length, 0);
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('cleaning a row frees real capacity for a new named reservation', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const fingerprint = await realProjectFingerprint(fx.base);
    for (const slug of ['cap-a', 'cap-b', 'cap-c']) {
      await seedIdleRow(fx, 'opencode2', slug, { isolationMode: 'non_isolated', fingerprint });
    }
    // Fourth named run fits (capacity 4).
    const fourth = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'cap-d',
      isolated: false,
      ownerTuple: { pid: 71, processStartId: 'ps-cap', bootId: 'boot-cap' },
    });
    await revalidateV2SessionRowBeforeSpawn(fourth);
    // Keep the fourth session PUBLISHED (mapping + idle): capacity stays full.
    await writeStoreMapping(fx.base, 'opencode2', 'cap-d', 'ses_cap_d');
    await completeV2SessionRow(fourth, 'ses_cap_d');
    // Fifth distinct slug MUST hit the hard capacity cap while full.
    await assert.rejects(
      () => reserveV2SessionRow({
        engine: 'opencode2',
        slug: 'cap-e',
        isolated: false,
        ownerTuple: { pid: 72, processStartId: 'ps-cap2', bootId: 'boot-cap2' },
      }),
      /exceeds 4 entries|no free lock slot/,
    );
    // Cleaning ONE seeded row genuinely frees capacity for the next run.
    await runCoderSessionClean('cap-a', { engine: 'opencode2' });
    const fifth = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'cap-f',
      isolated: false,
      ownerTuple: { pid: 73, processStartId: 'ps-cap3', bootId: 'boot-cap3' },
    });
    assert.ok(fifth);
    await fifth.releaseRunLease();
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

// ─── Round 2: lease hierarchy barriers ─────────────────────────────────────

test('a non-isolated named run serializes on the conditional-target lease', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const root = await openManagedTrissRoot(fx.base);
    const heldTarget = await acquireCoderTargetLease({ parentHandle: root });
    let settled = false;
    const run = reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'tgt-barrier',
      isolated: false, // NON-isolated: must take the target lease and block
      ownerTuple: { pid: 91, processStartId: 'ps-t', bootId: 'boot-t' },
    }).then((s) => { settled = true; return s; });
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(settled, false, 'a second non-isolated cycle must wait on the target lease');
    await heldTarget.release();
    const session = await run;
    assert.equal(settled, true);
    await session.releaseRunLease();
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('an exclusive maintenance holder blocks a new run without deadlock', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const root = await openManagedTrissRoot(fx.base);
    const exclusiveMaintenance = await acquireFixedKernelLock({ parentHandle: root, basename: 'maintenance.lock', mode: 'exclusive' });
    let settled = false;
    const run = reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'maint-barrier',
      isolated: false,
      ownerTuple: { pid: 92, processStartId: 'ps-m', bootId: 'boot-m' },
    }).then((s) => { settled = true; return s; });
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(settled, false, 'shared maintenance must wait for an active exclusive holder');
    await exclusiveMaintenance.release();
    const session = await run;
    assert.equal(settled, true);
    await session.releaseRunLease();
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('run + clean of the same slug: active run fails clean fast, published idle cleans fully', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const session = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'run-clean',
      isolated: false,
      ownerTuple: { pid: 93, processStartId: 'ps-rc', bootId: 'boot-rc' },
    });
    await revalidateV2SessionRowBeforeSpawn(session); // row running, run lease HELD
    // While the live run owns the slug, clean MUST fail closed (never mutate
    // a running row), and the row must survive untouched.
    await assert.rejects(
      () => runCoderSessionClean('run-clean', { engine: 'opencode2' }),
      /not idle \(state=running\)/,
    );
    let inv = await readCoderSessionInventory(join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2'));
    assert.equal(inv.entries.length, 1);
    assert.equal(inv.entries[0].state, 'running');
    assert.equal(inv.entries[0].pid, 93);

    // The run completes successfully (durable mapping first, then envelope):
    // the row is published idle with its slot/target/maintenance released.
    await writeStoreMapping(fx.base, 'opencode2', 'run-clean', 'ses_run_clean');
    await completeV2SessionRow(session, 'ses_run_clean');
    inv = await readCoderSessionInventory(join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2'));
    assert.equal(inv.entries[0].state, 'idle');

    // NOW the same clean converges: deleting breadcrumb -> mapping cleared ->
    // row removed.
    await runCoderSessionClean('run-clean', { engine: 'opencode2' });
    inv = await readCoderSessionInventory(join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2'));
    assert.equal(inv.entries.length, 0);
    const store = await readStore(fx.base);
    assert.equal(store.engines.opencode2['run-clean'], undefined);
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

// ─── Round 3: orphan-mapping admission gate + exact attribution ────────────

test('an orphan mapping WITHOUT an inventory row blocks a new reservation (byte-identical retain)', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const dir = join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2');
    await mkdir(dir, { mode: 0o700, recursive: true });
    await writeStoreMapping(fx.base, 'opencode2', 'foo', 'ses_old_foreign');
    const before = JSON.stringify(await readStore(fx.base));
    await assert.rejects(
      () => reserveV2SessionRow({
        engine: 'opencode2',
        slug: 'foo',
        isolated: false,
        ownerTuple: { pid: process.pid, processStartId: 'ps-o', bootId: 'boot-o' },
      }),
      (err) => err?.code === 'TRISS_CODER_SESSION_STORE_INVALID' && /NO inventory row/.test(err.message),
    );
    const after = JSON.stringify(await readStore(fx.base));
    assert.equal(after, before, 'the orphan mapping must survive byte-identical');
    const inv = await readCoderSessionInventory(dir);
    assert.equal(inv.entries.length, 0, 'no row may be created over an orphan mapping');
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('a malformed store without any row blocks a new reservation too', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const dir = join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2');
    await mkdir(dir, { mode: 0o700, recursive: true });
    await writeFile(join(fx.base, '.triss', 'sessions.json'), JSON.stringify({ version: 2, engines: { opencode2: 'not-an-object' } }), { mode: 0o600 });
    const before = JSON.stringify(await readStore(fx.base));
    await assert.rejects(
      () => reserveV2SessionRow({
        engine: 'opencode2',
        slug: 'bar',
        isolated: false,
        ownerTuple: { pid: process.pid, processStartId: 'ps-m', bootId: 'boot-m' },
      }),
      (err) => err?.code === 'TRISS_CODER_SESSION_STORE_INVALID',
    );
    const after = JSON.stringify(await readStore(fx.base));
    assert.equal(after, before);
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('a failed NEW run never adopts a pre-existing mapping (exact-id attribution)', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const dir = join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2');
    await mkdir(dir, { mode: 0o700, recursive: true });
    // Foreign mapping + a row THIS test created directly (simulating the
    // admission that would have been rejected by the orphan gate in real
    // flow terms — here we verify the FINALIZER independently).
    await writeStoreMapping(fx.base, 'opencode2', 'attr', 'ses_foreign');
    const seededRow = await reserveCoderSession({
      inventoryDir: dir,
      engine: 'opencode2',
      slug: 'attr',
      isolationMode: 'non_isolated',
      lockSlot: 0,
      projectRootFingerprint: FP,
      runId: 'run_attr',
      sandboxId: `sbx_${'a'.repeat(32)}`,
      pid: 77,
      processStartId: 'ps-attr',
      bootId: 'boot-attr',
    });
    // Minimal run-lease stub: the finalizer only needs withInventory/release.
    const fakeLease = {
      async withInventory(callback) { return callback(); },
      async release() {}
    };
    // Production pins the IMMUTABLE incarnation identity at admission; a
    // different instance id means a different (replacement) session.
    const fakeSession = {
      inventoryDir: dir,
      engine: 'opencode2',
      slug: 'attr',
      runId: 'run_attr',
      sandboxId: `sbx_${'a'.repeat(32)}`,
      instanceId: seededRow.session_instance_id,
      pid: 77,
      processStartId: 'ps-attr',
      bootId: 'boot-attr',
      origin: 'new_reservation',
      publishedRealId: undefined, // publication NEVER happened
      resumedRealId: null,
      runLease: fakeLease,
      releaseRunLease: () => fakeLease.release(),
    };
    await releaseV2SessionRow(fakeSession);
    // The row is RETAINED (never idle over a foreign mapping)…
    let inv = await readCoderSessionInventory(dir);
    assert.equal(inv.entries.length, 1);
    assert.equal(inv.entries[0].state, 'reserved');
    // …and the foreign mapping is untouched.
    const store = await readStore(fx.base);
    assert.equal(store.engines.opencode2['attr'], 'ses_foreign');

    // Contrast: when THIS run DID publish its exact id before failing, the
    // matching mapping lets the row survive as idle.
    const fakePublished = {
      ...fakeSession,
      publishedRealId: 'ses_mine',
    };
    await writeStoreMapping(fx.base, 'opencode2', 'attr', 'ses_mine');
    await releaseV2SessionRow(fakePublished);
    inv = await readCoderSessionInventory(dir);
    assert.equal(inv.entries.length, 1);
    assert.equal(inv.entries[0].state, 'idle');
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});


test('clean ABA guard: a same-slug replacement is never deletable by an older attempt', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const fingerprint = await realProjectFingerprint(fx.base);
    const dir = join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2');
    await mkdir(dir, { mode: 0o700, recursive: true });
    await seedIdleRow(fx, 'opencode2', 'aba', { isolationMode: 'non_isolated', fingerprint });
    const root = await openManagedTrissRoot(fx.base);
    // Pause the clean AFTER its maintenance-scoped discovery but BEFORE it
    // can take the target/slot leases (both are required for a
    // non-isolated row): holding the target lease parks it deterministically.
    const parkedTarget = await acquireCoderTargetLease({ parentHandle: root });
    let cleanSettled = false;
    const cleanP = runCoderSessionClean('aba', { engine: 'opencode2' })
      .then(() => { cleanSettled = true; }, (e) => { cleanSettled = true; throw e; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(cleanSettled, false, 'clean must be parked on the target lease');

    // While it is parked: another actor removes the OLD session and a NEW
    // run publishes a REPLACEMENT with the same slug (different slot/mode).
    await beginCoderSessionDelete({
      inventoryDir: dir,
      engine: 'opencode2',
      slug: 'aba',
      runId: 'run_swap_old',
      sandboxId: `sbx_${'b'.repeat(32)}`,
      pid: 501,
      processStartId: 'ps-swap',
      bootId: 'boot-swap',
    });
    // Remove the OLD row entirely (deleting -> removed), freeing the slug.
    const { removeCoderSessionRow } = await import('../src/coder-session-transitions.js');
    await removeCoderSessionRow({ inventoryDir: dir, engine: 'opencode2', slug: 'aba' });
    const replacement = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'aba',
      isolated: true, // different mode + fresh created_at: a DIFFERENT row
      ownerTuple: { pid: 502, processStartId: 'ps-new', bootId: 'boot-new' },
    });
    assert.ok(replacement);
    await revalidateV2SessionRowBeforeSpawn(replacement);
    await writeStoreMapping(fx.base, 'opencode2', 'aba', 'ses_replacement');
    await completeV2SessionRow(replacement, 'ses_replacement');

    // Unpark the clean, then it must FAIL CLOSED on the ABA guard…
    await parkedTarget.release();
    await assert.rejects(
      () => cleanP,
      /ABA guard/,
    );
    // …and the REPLACEMENT must survive intact (idle, its own identity).
    const inv = await readCoderSessionInventory(dir);
    assert.equal(inv.entries.length, 1);
    assert.equal(inv.entries[0].state, 'idle');
    assert.equal(inv.entries[0].isolation_mode, 'isolated');
    const store = await readStore(fx.base);
    assert.equal(store.engines.opencode2['aba'], 'ses_replacement');
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await fx.cleanup();
  }
});

test('clean ABA guard survives a frozen clock: identical created_at still cannot swap identity', async () => {
  const fx = await fixture();
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = fx.base;
  try {
    const fingerprint = await realProjectFingerprint(fx.base);
    const dir = join(fx.base, '.triss', 'engine-sessions-v2', 'opencode2');
    await mkdir(dir, { mode: 0o700, recursive: true });
    // Two incarnations that coincide on EVERY legacy anchor: slug,
    // isolation_mode, lock_slot, project fingerprint AND the exact
    // millisecond created_at (deterministic frozen clock). The immutable
    // session_instance_id is the ONLY difference — timestamps are metadata,
    // never identity.
    const incarnation = (instanceId) => ({
      engine: 'opencode2',
      slug: 'frozen',
      session_instance_id: instanceId,
      isolation_mode: 'non_isolated',
      lock_slot: 0,
      state: 'idle',
      run_id: null,
      sandbox_id: null,
      pid: null,
      process_start_id: null,
      boot_id: null,
      project_root_fingerprint: fingerprint,
      reserved_bytes: RESERVED_BYTES,
      deleting_basename: null,
      session_delete_phase: null,
      created_at: NOW,
      updated_at: NOW,
    });
    await writeFile(join(dir, '.inventory.json'), JSON.stringify({
      schema_version: 1,
      entries: [incarnation('c'.repeat(32))],
      updated_at: NOW,
    }) + '\n', { mode: 0o600 });

    const root = await openManagedTrissRoot(fx.base);
    // Park the clean AFTER its maintenance-scoped discovery but BEFORE the
    // target lease (required for this non-isolated row).
    const parkedTarget = await acquireCoderTargetLease({ parentHandle: root });
    let cleanSettled = false;
    const cleanP = runCoderSessionClean('frozen', { engine: 'opencode2' })
      .then(() => { cleanSettled = true; }, (e) => { cleanSettled = true; throw e; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(cleanSettled, false, 'clean must be parked on the target lease');

    // While parked: incarnation ONE is removed and a byte-identical
    // EXCEPT-instance-id incarnation TWO is published in its place.
    const { removeCoderSessionRow } = await import('../src/coder-session-transitions.js');
    await beginCoderSessionDelete({
      inventoryDir: dir,
      engine: 'opencode2',
      slug: 'frozen',
      runId: 'run_swap_old',
      sandboxId: `sbx_${'c'.repeat(32)}`,
      pid: 601,
      processStartId: 'ps-swap',
      bootId: 'boot-swap',
    });
    await removeCoderSessionRow({ inventoryDir: dir, engine: 'opencode2', slug: 'frozen' });
    await writeFile(join(dir, '.inventory.json'), JSON.stringify({
      schema_version: 1,
      entries: [incarnation('d'.repeat(32))],
      updated_at: NOW,
    }) + '\n', { mode: 0o600 });

    // Unpark: the older clean attempt MUST fail closed on instance identity…
    await parkedTarget.release();
    await assert.rejects(() => cleanP, /ABA guard/);
    // …leaving incarnation TWO fully intact (its own instance id, idle).
    const inv = await readCoderSessionInventory(dir);
    assert.equal(inv.entries.length, 1);
    assert.equal(inv.entries[0].session_instance_id, 'd'.repeat(32));
    assert.equal(inv.entries[0].state, 'idle');
    assert.equal(inv.entries[0].created_at, NOW, 'the replacement kept the shared frozen timestamp');
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
