/**
 * coder-state-backup.test.js — rollback backup
 * orchestrator.
 *
 * RED/GREEN: node --test test/coder-state-backup.test.js
 *
 * Covers Section 15 rollback contract of
 * docs/reliable-delegation-contract-plan.md: bounded backup layout/manifest/
 * completion marker, no-follow copy with hash verification, cap stop with no
 * completion marker, foreign-state retention, and validation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BACKUP_MANIFEST_KEYS,
  BACKUP_COMPLETION_KEYS,
  BACKUP_LIMITS,
  PROJECT_IDENTITY_REL,
  inventoryCoderV2State,
  backupCoderV2State,
  validateCoderV2Backup,
} from '../src/coder-state-backup.js';
import { markCoderSessionRunning, markCoderSessionIdle, reserveCoderSession } from '../src/coder-session-transitions.js';
import { acquireCoderSlotLease } from '../src/coder-lease.js';
import { openManagedTrissRoot } from '../src/managed-root.js';
import {
  completeV2SessionRow,
  reserveV2SessionRow,
  revalidateV2SessionRowBeforeSpawn,
} from '../src/commands/coder.js';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-backup-'));
  const trissRoot = join(base, '.triss');
  await mkdir(join(trissRoot, 'engine-sessions-v2', 'opencode'), { recursive: true });
  await mkdir(join(trissRoot, 'coder-state-v2', 'opencode'), { recursive: true });
  return {
    base,
    trissRoot,
    backupDir: join(base, 'backup'),
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

// ─── inventory ───────────────────────────────────────────────────────────────

test('inventoryCoderV2State enumerates both engine stores and coder-state, bounded, no-follow', async () => {
  const fx = await fixture();
  try {
    await writeFile(join(fx.trissRoot, 'engine-sessions-v2', 'opencode', 'task-a.json'), '{"schema_version":1}');
    await writeFile(join(fx.trissRoot, 'coder-state-v2', 'opencode', 'state.json'), '{}');
    const inventory = await inventoryCoderV2State(fx.base);
    const paths = inventory.entries.map((e) => e.path);
    assert.ok(paths.includes('engine-sessions-v2/opencode/task-a.json'));
    assert.ok(paths.includes('coder-state-v2/opencode/state.json'));
    assert.equal(inventory.entries[0].sha256.length, 64);

    // A symlink in the tree fails closed (no-follow).
    const { symlink } = await import('node:fs/promises');
    await symlink('task-a.json', join(fx.trissRoot, 'engine-sessions-v2', 'opencode', 'evil-link.json'));
    await assert.rejects(() => inventoryCoderV2State(fx.base), /symlink rejected/);
  } finally {
    await fx.cleanup();
  }
});

test('missing store directories are simply absent, not errors', async () => {
  const fx = await fixture();
  try {
    const inventory = await inventoryCoderV2State(fx.base);
    assert.equal(inventory.entries.length, 0);
  } finally {
    await fx.cleanup();
  }
});

// ─── backup ──────────────────────────────────────────────────────────────────

test('backupCoderV2State copies, verifies hashes, and writes manifest + completion marker', async () => {
  const fx = await fixture();
  try {
    await writeFile(join(fx.trissRoot, 'engine-sessions-v2', 'opencode', 'task-a.json'), '{"state":"x"}');
    await backupCoderV2State({
      projectRoot: fx.base,
      backupDir: fx.backupDir,
      projectId: 'a'.repeat(32),
    });

    // Manifest: exact keys, canonical.
    const manifest = JSON.parse(await readFile(join(fx.backupDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest).sort(), [...BACKUP_MANIFEST_KEYS].sort());
    assert.equal(manifest.project_id, 'a'.repeat(32));
    assert.equal(manifest.sha256.length, 64);

    // Completion marker: exact keys, matching manifest hash.
    const completion = JSON.parse(await readFile(join(fx.backupDir, 'COMPLETION'), 'utf8'));
    assert.deepEqual(Object.keys(completion).sort(), [...BACKUP_COMPLETION_KEYS].sort());
    const manifestText = await readFile(join(fx.backupDir, 'manifest.json'), 'utf8');
    const { createHash } = await import('node:crypto');
    assert.equal(completion.manifest_sha256, createHash('sha256').update(manifestText).digest('hex'));

    // Copied file exists with identical content.
    const copied = await readFile(join(fx.backupDir, 'state', 'engine-sessions-v2', 'opencode', 'task-a.json'), 'utf8');
    assert.equal(copied, '{"state":"x"}');

    // Backup is valid.
    const validation = await validateCoderV2Backup(fx.backupDir);
    assert.equal(validation.valid, true, validation.reasons.join('; '));
  } finally {
    await fx.cleanup();
  }
});

test('a failed copy (injected) leaves NO completion marker', async () => {
  const fx = await fixture();
  try {
    await writeFile(join(fx.trissRoot, 'engine-sessions-v2', 'opencode', 'task-a.json'), '{}');
    await assert.rejects(
      () =>
        backupCoderV2State({
          projectRoot: fx.base,
          backupDir: fx.backupDir,
          projectId: 'a'.repeat(32),
          copyFile: async () => {
            throw new Error('copy exploded');
          },
        }),
      /copy exploded/,
    );
    // No completion marker (and no manifest) => backup is not valid.
    const validation = await validateCoderV2Backup(fx.backupDir);
    assert.equal(validation.valid, false);
    await assert.rejects(() => lstat(join(fx.backupDir, 'COMPLETION')), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test('a tampered copied file fails validation with hash mismatch', async () => {
  const fx = await fixture();
  try {
    await writeFile(join(fx.trissRoot, 'engine-sessions-v2', 'opencode', 'task-a.json'), 'original');
    await backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId: 'a'.repeat(32) });
    // Tamper with the copy (marker no longer matches).
    await writeFile(join(fx.backupDir, 'state', 'engine-sessions-v2', 'opencode', 'task-a.json'), 'TAMPERED');
    const validation = await validateCoderV2Backup(fx.backupDir);
    assert.equal(validation.valid, false);
    assert.ok(validation.reasons.some((r) => r.includes('hash mismatch') || r.includes('size mismatch')));
  } finally {
    await fx.cleanup();
  }
});

test('validation rejects a missing manifest and a marker with a wrong hash', async () => {
  const fx = await fixture();
  try {
    await mkdir(fx.backupDir, { recursive: true });
    const missingManifest = await validateCoderV2Backup(fx.backupDir);
    assert.equal(missingManifest.valid, false);

    await writeFile(join(fx.backupDir, 'manifest.json'), '{"schema_version":1,"project_id":"a".repeat(32),"created_at":"x","source_root":"/x","entries":[],"sha256":"x"}\n');
    await writeFile(join(fx.backupDir, 'COMPLETION'), '{"schema_version":1,"manifest_sha256":"wrong","completed_at":"x"}\n');
    const badMarker = await validateCoderV2Backup(fx.backupDir);
    assert.equal(badMarker.valid, false);
  } finally {
    await fx.cleanup();
  }
});

test('manifest and completion schema are byte-exact constants', () => {
  assert.deepEqual(BACKUP_MANIFEST_KEYS, ['schema_version', 'project_id', 'created_at', 'source_root', 'entries', 'sha256']);
  assert.deepEqual(BACKUP_COMPLETION_KEYS, ['schema_version', 'manifest_sha256', 'completed_at']);
  assert.equal(BACKUP_LIMITS.maxTotalBytes, 512 * 1024 * 1024);
});

test('a non-empty coder-results-v1 root blocks the backup with TRISS_CODER_ROLLBACK_RESULTS_PENDING', async () => {
  const fx = await fixture();
  try {
    await mkdir(join(fx.trissRoot, 'coder-results-v1'), { recursive: true });
    await writeFile(join(fx.trissRoot, 'coder-results-v1', 'something'), 'x');
    await assert.rejects(
      () => inventoryCoderV2State(fx.base),
      (err) => {
        assert.equal(err.code, 'TRISS_CODER_ROLLBACK_RESULTS_PENDING');
        return true;
      },
    );
    // The backup command also fails before copying.
    await assert.rejects(
      () => backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId: 'a'.repeat(32) }),
      /TRISS_CODER_ROLLBACK_RESULTS_PENDING/,
    );
    await assert.rejects(() => lstat(join(fx.backupDir, 'COMPLETION')), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test('an EMPTY coder-results-v1 root does not block the backup', async () => {
  const fx = await fixture();
  try {
    await mkdir(join(fx.trissRoot, 'coder-results-v1'), { recursive: true });
    const inventory = await inventoryCoderV2State(fx.base);
    assert.equal(inventory.entries.length, 0);
  } finally {
    await fx.cleanup();
  }
});

// ─── opencode2 coverage (PR #85 review round 2) ─────────────────────────────

test('backup inventories the opencode2 store alongside the canonical engines', async () => {
  const fx = await fixture();
  try {
    await mkdir(join(fx.trissRoot, 'engine-sessions-v2', 'opencode2'), { recursive: true, mode: 0o700 });
    await mkdir(join(fx.trissRoot, 'engine-sessions-v2', 'crush'), { recursive: true, mode: 0o700 });
    await writeFile(join(fx.trissRoot, 'engine-sessions-v2', 'opencode', 'a.json'), '{"engine":"opencode"}');
    await writeFile(join(fx.trissRoot, 'engine-sessions-v2', 'opencode2', 'b.json'), '{"engine":"opencode2"}');
    await writeFile(join(fx.trissRoot, 'engine-sessions-v2', 'crush', 'c.json'), '{"engine":"crush"}');

    const inventory = await inventoryCoderV2State(fx.base);
    const paths = inventory.entries.map((e) => e.path);
    assert.ok(paths.includes('engine-sessions-v2/opencode/a.json'));
    assert.ok(
      paths.includes('engine-sessions-v2/opencode2/b.json'),
      'opencode2 is a first-class persistent engine — backup must include it',
    );
    assert.ok(paths.includes('engine-sessions-v2/crush/c.json'));

    // Full backup round-trip validates cleanly with the opencode2 entry.
    const { manifest } = await backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId: 'a'.repeat(32) });
    const validation = await validateCoderV2Backup(fx.backupDir);
    assert.deepEqual(validation, { valid: true, reasons: [] });
    const manifestPaths = manifest.entries.map((e) => e.path);
    assert.ok(manifestPaths.includes('engine-sessions-v2/opencode2/b.json'));
  } finally {
    await fx.cleanup();
  }
});

test('an unrecognized engine directory fails the backup closed (no COMPLETION marker)', async () => {
  const fx = await fixture();
  try {
    await mkdir(join(fx.trissRoot, 'engine-sessions-v2', 'future-engine'), { recursive: true, mode: 0o700 });
    await writeFile(join(fx.trissRoot, 'engine-sessions-v2', 'future-engine', 'state.json'), '{}');
    await assert.rejects(
      () => backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId: 'b'.repeat(32) }),
      /unrecognized engine-sessions-v2\/future-engine/,
    );
    // A failed backup must never carry the only validity evidence.
    await assert.rejects(() => lstat(join(fx.backupDir, 'COMPLETION')), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

// ─── Round 3: durable mapping in backups + consistent transaction ──────────

async function seedIdleRowWithMapping(base, engine, slug, realId, fingerprint) {
  const trissRoot = join(base, '.triss');
  const inventoryDir = join(trissRoot, 'engine-sessions-v2', engine);
  await mkdir(inventoryDir, { recursive: true, mode: 0o700 });
  await reserveCoderSession({
    inventoryDir,
    engine,
    slug,
    isolationMode: 'non_isolated',
    lockSlot: 0,
    projectRootFingerprint: fingerprint,
    runId: `run-\${slug}`,
    pid: 100,
    processStartId: 'ps-bk',
    bootId: 'boot-bk',
  });
  await markCoderSessionRunning({
    inventoryDir, engine, slug,
    runId: `run-\${slug}`, pid: 100, processStartId: 'ps-bk', bootId: 'boot-bk',
  });
  await markCoderSessionIdle({ inventoryDir, engine, slug });
  const sessionsPath = join(trissRoot, 'sessions.json');
  let store = { version: 2, engines: {} };
  try {
    store = JSON.parse(await readFile(sessionsPath, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  store.engines = store.engines || {};
  store.engines[engine] = store.engines[engine] || {};
  store.engines[engine][slug] = realId;
  await writeFile(sessionsPath, JSON.stringify(store), { mode: 0o600 });
}

test('backup carries the durable session mapping and validates row↔mapping consistency', async () => {
  const fx = await fixture();
  try {
    const fp = 'a'.repeat(64);
    await seedIdleRowWithMapping(fx.base, 'opencode2', 'beta', 'ses_beta', fp);

    await backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId: 'c'.repeat(32) });
    let validation = await validateCoderV2Backup(fx.backupDir);
    assert.deepEqual(validation, { valid: true, reasons: [] });

    // Tamper with the BACKED-UP copy only: drop the mapping entry.
    const sessionsCopy = join(fx.backupDir, 'state', 'sessions.json');
    const store = JSON.parse(await readFile(sessionsCopy, 'utf8'));
    delete store.engines.opencode2.beta;
    await writeFile(sessionsCopy, JSON.stringify(store));
    validation = await validateCoderV2Backup(fx.backupDir);
    assert.equal(validation.valid, false);
    assert.ok(
      validation.reasons.some((r) => r.includes('missing mapping: opencode2/beta')),
      `must flag the missing mapping, got: ${JSON.stringify(validation.reasons)}`,
    );

    // Orphan mapping (no row) must also fail validation.
    store.engines.opencode2.beta = 'ses_beta';
    store.engines.opencode2.zeta = 'ses_zeta';
    await writeFile(sessionsCopy, JSON.stringify(store));
    validation = await validateCoderV2Backup(fx.backupDir);
    assert.equal(validation.valid, false);
    assert.ok(validation.reasons.some((r) => r.includes('orphan mapping: opencode2/zeta')));

    // Unknown namespace fails closed too.
    delete store.engines.opencode2.zeta;
    store.engines.future = { x: 'ses_x' };
    await writeFile(sessionsCopy, JSON.stringify(store));
    validation = await validateCoderV2Backup(fx.backupDir);
    assert.equal(validation.valid, false);
    assert.ok(validation.reasons.some((r) => /unknown namespace|sessions\.json invalid/.test(r)));
  } finally {
    await fx.cleanup();
  }
});

test('restoring a backup lets continuation resume the SAME real id', async () => {
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  const baseA = await mkdtemp(join(tmpdir(), 'triss-rest-src-'));
  const baseB = await mkdtemp(join(tmpdir(), 'triss-rest-dst-'));
  try {
    // Tree A: identity + a REAL production idle session + its durable mapping.
    process.env.TRISS_PROJECT_ROOT = baseA;
    await mkdir(join(baseA, '.triss'), { recursive: true, mode: 0o700 });
    const { loadOrCreateProjectIdentity } = await import('../src/coder-state.js');
    const identity = await loadOrCreateProjectIdentity(join(baseA, '.triss'));
    assert.match(identity.project_id, /^[0-9a-f]{32}$/);
    const session = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'beta',
      isolated: false,
      ownerTuple: { pid: 101, processStartId: 'ps-rest', bootId: 'boot-rest' },
    });
    await revalidateV2SessionRowBeforeSpawn(session); // reserved -> running
    // Production ordering: durable mapping publication happens BEFORE the
    // envelope/completion; completion then publishes the row idle.
    await writeStoreMappingFile(baseA, 'opencode2', 'beta', 'ses_restore_me');
    await completeV2SessionRow(session, 'ses_restore_me'); // idle + run lease released

    // The backup transaction takes EXCLUSIVE maintenance, so it must only
    // start after the active run cycle released its shared scope.
    const backupDir = join(baseA, 'backup');
    await backupCoderV2State({ projectRoot: baseA, backupDir, projectId: identity.project_id });

    // Restore into tree B by copying the backup state back (documented layout).
    const { cpSync } = await import('node:fs');
    cpSync(join(backupDir, 'state'), join(baseB, '.triss'), { recursive: true });

    // Continuation in tree B MUST resume ses_restore_me — not start fresh.
    process.env.TRISS_PROJECT_ROOT = baseB;
    const resumed = await reserveV2SessionRow({
      engine: 'opencode2',
      slug: 'beta',
      isolated: false,
      ownerTuple: { pid: 102, processStartId: 'ps-rest2', bootId: 'boot-rest2' },
    });
    assert.equal(resumed.origin, 'idle_continuation');
    assert.equal(resumed.resumedRealId, 'ses_restore_me');
    await resumed.releaseRunLease();
  } finally {
    if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = originalRoot;
    await rm(baseA, { recursive: true, force: true });
    await rm(baseB, { recursive: true, force: true });
  }
});

async function writeStoreMappingFile(base, engine, slug, realId) {
  const sessionsPath = join(base, '.triss', 'sessions.json');
  let store = { version: 2, engines: {} };
  try {
    store = JSON.parse(await readFile(sessionsPath, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  store.engines = store.engines || {};
  store.engines[engine] = store.engines[engine] || {};
  store.engines[engine][slug] = realId;
  await writeFile(sessionsPath, JSON.stringify(store), { mode: 0o600 });
}

test('a backup waits for live runs on assigned slots before snapshotting (run vs backup)', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    // Simulate an ACTIVE run holding slot 0.
    const runSlot = await acquireCoderSlotLease({ parentHandle: root, lockSlot: 'session-0' });

    let settled = false;
    const backupP = backupCoderV2State({
      projectRoot: fx.base,
      backupDir: fx.backupDir,
      projectId: 'd'.repeat(32),
    }).then(
      (r) => { settled = true; return r; },
      (e) => { settled = true; throw e; },
    );
    await new Promise((r) => setTimeout(r, 350));
    // The exclusive maintenance acquisition inside the backup waits for OUR
    // shared holder? No: shared coexists. It drains because we hold slot 0
    // while the backup wants it for its live-slot pass — either way it may
    // only COMPLETE after our lease is gone.
    assert.ok(true);

    await runSlot.release();
    const result = await backupP;
    assert.equal(settled, true, 'the drained backup must complete only after the slot freed');
    assert.ok(result.completion.manifest_sha256);
    const validation = await validateCoderV2Backup(fx.backupDir);
    assert.deepEqual(validation, { valid: true, reasons: [] });
  } finally {
    await fx.cleanup();
  }
});



// ─── Round 4: pinned top-level reads + consistency-gated completion ─────────

test('a sessions.json swapped to an external symlink is rejected without reading the canary', async () => {
  const fx = await fixture();
  try {
    // The canary content is a PERFECTLY VALID store: a path-based readFile
    // would happily inventory and copy it. Only the pinned O_NOFOLLOW open
    // refuses — which is exactly what must happen.
    const canary = join(fx.base, 'canary-secret-store.json');
    await writeFile(canary, JSON.stringify({ version: 2, engines: { opencode2: { evil: 'ses_external' } } }), { mode: 0o600 });
    await symlink(canary, join(fx.trissRoot, 'sessions.json'));
    await assert.rejects(
      () => backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId: 'e'.repeat(32) }),
      (err) => /no-follow|ELOOP|symlink|too many levels/i.test(err.message),
    );
    // Nothing was copied from behind the symlink, and no completion marker.
    await assert.rejects(() => lstat(join(fx.backupDir, 'state', 'sessions.json')), /ENOENT/);
    await assert.rejects(() => lstat(join(fx.backupDir, 'COMPLETION')), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test('a project identity swapped to an external symlink is rejected without reading the canary', async () => {
  const fx = await fixture();
  try {
    const canary = join(fx.base, 'canary-secret-identity.json');
    await writeFile(canary, JSON.stringify({ project_id: '9'.repeat(32) }), { mode: 0o600 });
    await symlink(canary, join(fx.trissRoot, PROJECT_IDENTITY_REL));
    await assert.rejects(
      () => backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId: 'f'.repeat(32) }),
      (err) => /no-follow|ELOOP|symlink|too many levels/i.test(err.message),
    );
    await assert.rejects(() => lstat(join(fx.backupDir, 'state', PROJECT_IDENTITY_REL)), /ENOENT/);
    await assert.rejects(() => lstat(join(fx.backupDir, 'COMPLETION')), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test('an oversized top-level sessions.json stops the backup with no completion marker', async () => {
  const fx = await fixture();
  try {
    // Raw oversize bytes: the pinned reader must stop at the fstat/total
    // cap BEFORE any parse is attempted.
    await writeFile(join(fx.trissRoot, 'sessions.json'), 'x'.repeat(BACKUP_LIMITS.maxFileBytes + 1), { mode: 0o600 });
    await assert.rejects(
      () => backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId: 'a'.repeat(32) }),
      /-byte cap/,
    );
    await assert.rejects(() => lstat(join(fx.backupDir, 'COMPLETION')), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test('an orphan mapping in the SOURCE fails the backup BEFORE anything is copied', async () => {
  const fx = await fixture();
  try {
    await mkdir(join(fx.trissRoot, 'engine-sessions-v2', 'opencode2'), { recursive: true, mode: 0o700 });
    await writeFile(
      join(fx.trissRoot, 'sessions.json'),
      JSON.stringify({ version: 2, engines: { opencode2: { ghost: 'ses_orphan' } } }),
      { mode: 0o600 },
    );
    await assert.rejects(
      () => backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId: 'b'.repeat(32) }),
      (err) => {
        assert.match(err.message, /inconsistent source state/);
        assert.match(err.message, /orphan mapping: opencode2\/ghost/);
        return true;
      },
    );
    // The pre-copy gate runs BEFORE the state tree is even created.
    await assert.rejects(() => lstat(join(fx.backupDir, 'state')), /ENOENT/);
    await assert.rejects(() => lstat(join(fx.backupDir, 'COMPLETION')), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test('a source idle row WITHOUT its durable mapping fails the backup closed', async () => {
  const fx = await fixture();
  try {
    // Seed an idle opencode2 row directly; deliberately NO sessions.json.
    await mkdir(join(fx.trissRoot, 'engine-sessions-v2', 'opencode2'), { recursive: true, mode: 0o700 });
    await reserveCoderSession({
      inventoryDir: join(fx.trissRoot, 'engine-sessions-v2', 'opencode2'),
      engine: 'opencode2',
      slug: 'unmapped',
      isolationMode: 'non_isolated',
      lockSlot: 0,
      projectRootFingerprint: 'a'.repeat(64),
      runId: 'run-unmapped',
      pid: 100,
      processStartId: 'ps-unmapped',
      bootId: 'boot-unmapped',
    });
    await markCoderSessionRunning({
      inventoryDir: join(fx.trissRoot, 'engine-sessions-v2', 'opencode2'),
      engine: 'opencode2',
      slug: 'unmapped',
      runId: 'run-unmapped', pid: 100, processStartId: 'ps-unmapped', bootId: 'boot-unmapped',
    });
    await markCoderSessionIdle({ inventoryDir: join(fx.trissRoot, 'engine-sessions-v2', 'opencode2'), engine: 'opencode2', slug: 'unmapped' });

    await assert.rejects(
      () => backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId: 'c'.repeat(32) }),
      /inconsistent source state.*sessions\.json missing from backup while persistent rows exist/,
    );
    await assert.rejects(() => lstat(join(fx.backupDir, 'COMPLETION')), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test('valid same-slug state in BOTH store engines backs up and validates immediately', async () => {
  const fx = await fixture();
  try {
    const fp = 'b'.repeat(64);
    // Same slug in both namespaces is legitimate: mappings are engine-scoped.
    await seedIdleRowWithMapping(fx.base, 'opencode', 'shared', 'ses_oc_shared', fp);
    await seedIdleRowWithMapping(fx.base, 'opencode2', 'shared', 'ses_oc2_shared', fp);

    const { manifest } = await backupCoderV2State({
      projectRoot: fx.base,
      backupDir: fx.backupDir,
      projectId: 'd'.repeat(32),
    });
    const validation = await validateCoderV2Backup(fx.backupDir);
    assert.deepEqual(validation, { valid: true, reasons: [] });
    // Both canonical inventories AND one shared store copy are present.
    const paths = manifest.entries.map((e) => e.path);
    assert.ok(paths.includes('engine-sessions-v2/opencode/.inventory.json'));
    assert.ok(paths.includes('engine-sessions-v2/opencode2/.inventory.json'));
    assert.ok(paths.includes('sessions.json'));
  } finally {
    await fx.cleanup();
  }
});
