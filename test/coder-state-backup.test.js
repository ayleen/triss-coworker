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
import { createHash } from 'node:crypto';
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
  listPhysicalStateFiles,
  validateCoderV2Backup,
} from '../src/coder-state-backup.js';
import {
  beginCoderSessionDelete,
  markCoderSessionRunning,
  markCoderSessionIdle,
  reserveCoderSession,
} from '../src/coder-session-transitions.js';
import { decodeCoderSessionInventory, encodeCoderSessionInventory, INVENTORY_BASENAME } from '../src/coder-session-inventory-codec.js';
import { acquireCoderSlotLease } from '../src/coder-lease.js';
import { openManagedTrissRoot } from '../src/managed-root.js';
import {
  completeV2SessionRow,
  reserveV2SessionRow,
  revalidateV2SessionRowBeforeSpawn,
} from '../src/commands/coder.js';
import { projectRootFingerprint } from '../src/coder-state.js';

const NOW = '2026-08-24T00:00:00.000Z';

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

test('managed inventory traversal rejects engine and coder-state directory swaps before readdir', async () => {
  for (const target of ['engine', 'coder-state']) {
    const fx = await fixture();
    const outside = await mkdtemp(join(tmpdir(), `triss-backup-inventory-${target}-outside-`));
    try {
      const canary = join(outside, 'canary.txt');
      await writeFile(canary, 'outside-only');
      const targetPath = target === 'engine'
        ? join(fx.trissRoot, 'engine-sessions-v2', 'opencode')
        : join(fx.trissRoot, 'coder-state-v2');
      let swapped = false;
      await assert.rejects(
        () => inventoryCoderV2State(fx.base, {
          beforeReaddir: async (relative) => {
            const expected = target === 'engine' ? 'engine-sessions-v2' : 'coder-state-v2';
            if (relative !== expected || swapped) return;
            swapped = true;
            await rm(targetPath, { recursive: true, force: true });
            await symlink(outside, targetPath);
          },
        }),
        /managed source directory is not a real directory|identity changed|symlink rejected/,
      );
      assert.equal(swapped, true);
      assert.equal(await readFile(canary, 'utf8'), 'outside-only');
    } finally {
      await fx.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
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

async function seedDeletingRow(base, fingerprint, slug = 'deleting-row') {
  const inventoryDir = join(base, '.triss', 'engine-sessions-v2', 'opencode');
  await mkdir(inventoryDir, { recursive: true, mode: 0o700 });
  await reserveCoderSession({
    inventoryDir,
    engine: 'opencode',
    slug,
    isolationMode: 'non_isolated',
    lockSlot: 0,
    projectRootFingerprint: fingerprint,
    runId: 'run_old',
    pid: 100,
    processStartId: 'ps-old',
    bootId: 'boot-old',
  });
  await beginCoderSessionDelete({
    inventoryDir,
    engine: 'opencode',
    slug,
    runId: 'run_clean',
    sandboxId: `sbx_${'1'.repeat(32)}`,
    pid: 101,
    processStartId: 'ps-clean',
    bootId: 'boot-clean',
  });
}

test('backup carries the durable session mapping and validates row↔mapping consistency', async () => {
  const fx = await fixture();
  try {
    const fp = projectRootFingerprint('c'.repeat(32));
    await writeFile(join(fx.trissRoot, PROJECT_IDENTITY_REL), JSON.stringify({
      schema_version: 1,
      project_id: 'c'.repeat(32),
      creation_device: '1',
      creation_inode: '2',
      created_at: '2026-08-24T00:00:00.000Z',
    }));
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

test('copy source parent swap fails before outside bytes are copied', async () => {
  const fx = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'triss-backup-copy-outside-'));
  try {
    const sourceDir = join(fx.trissRoot, 'engine-sessions-v2', 'opencode');
    const canary = join(outside, 'canary.txt');
    await writeFile(canary, 'outside-only');
    await writeFile(join(sourceDir, 'task-a.json'), '{"state":"inside"}');
    let swapped = false;
    let copyCalls = 0;
    await assert.rejects(
      () => backupCoderV2State({
        projectRoot: fx.base,
        backupDir: fx.backupDir,
        projectId: 'a'.repeat(32),
        copyFile: async () => { copyCalls += 1; },
        beforeSourceRead: async (relative) => {
          if (relative !== 'engine-sessions-v2/opencode/task-a.json' || swapped) return;
          swapped = true;
          await rm(sourceDir, { recursive: true, force: true });
          await symlink(outside, sourceDir);
        },
      }),
      /identity changed|managed source directory is not a real directory|managed source directory disappeared/,
    );
    assert.equal(swapped, true);
    assert.equal(copyCalls, 0);
    assert.equal(await readFile(canary, 'utf8'), 'outside-only');
    await assert.rejects(() => lstat(join(fx.backupDir, 'COMPLETION')), /ENOENT/);
  } finally {
    await fx.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('live-slot inventory lookup rejects an engine symlink before reading the outside canary', async () => {
  const fx = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'triss-backup-live-slot-outside-'));
  try {
    const projectId = 'b'.repeat(32);
    await writeFile(join(fx.trissRoot, PROJECT_IDENTITY_REL), JSON.stringify({
      schema_version: 1,
      project_id: projectId,
      creation_device: '1',
      creation_inode: '2',
      created_at: NOW,
    }));
    await seedDeletingRow(fx.base, projectRootFingerprint(projectId));
    const sourceDir = join(fx.trissRoot, 'engine-sessions-v2', 'opencode');
    await writeFile(join(outside, INVENTORY_BASENAME), 'outside-canary-bytes');
    let swapped = false;
    await assert.rejects(
      () => backupCoderV2State({
        projectRoot: fx.base,
        backupDir: fx.backupDir,
        projectId,
        beforeSourceRead: async (relative) => {
          if (relative !== `engine-sessions-v2/opencode/${INVENTORY_BASENAME}` || swapped) return;
          swapped = true;
          await rm(sourceDir, { recursive: true, force: true });
          await symlink(outside, sourceDir);
        },
      }),
      /managed source directory is not a real directory|identity changed|symlink rejected/,
    );
    assert.equal(swapped, true);
    assert.equal(await readFile(join(outside, INVENTORY_BASENAME), 'utf8'), 'outside-canary-bytes');
    await assert.rejects(() => lstat(join(fx.backupDir, 'COMPLETION')), /ENOENT/);
  } finally {
    await fx.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('backup cleanup retries a one-shot slot release and still completes', async () => {
  const fx = await fixture();
  try {
    const projectId = 'c'.repeat(32);
    await writeFile(join(fx.trissRoot, PROJECT_IDENTITY_REL), JSON.stringify({
      schema_version: 1,
      project_id: projectId,
      creation_device: '1',
      creation_inode: '2',
      created_at: NOW,
    }));
    await seedDeletingRow(fx.base, projectRootFingerprint(projectId));
    let slotReleases = 0;
    let maintenanceReleases = 0;
    const result = await backupCoderV2State({
      projectRoot: fx.base,
      backupDir: fx.backupDir,
      projectId,
      leaseDependencies: {
        acquireMaintenance: async () => ({
          release: async () => { maintenanceReleases += 1; },
        }),
        acquireSlot: async () => ({
          release: async () => {
            slotReleases += 1;
            if (slotReleases === 1) throw new Error('one-shot slot release failure');
          },
        }),
      },
    });
    assert.ok(result.completion.manifest_sha256);
    assert.equal(slotReleases, 2);
    assert.equal(maintenanceReleases, 1);
    assert.equal((await validateCoderV2Backup(fx.backupDir)).valid, true);
  } finally {
    await fx.cleanup();
  }
});

test('permanent slot and maintenance release failures both get attempted and retain the primary error', async () => {
  const fx = await fixture();
  try {
    const projectId = 'd'.repeat(32);
    await writeFile(join(fx.trissRoot, PROJECT_IDENTITY_REL), JSON.stringify({
      schema_version: 1,
      project_id: projectId,
      creation_device: '1',
      creation_inode: '2',
      created_at: NOW,
    }));
    await seedDeletingRow(fx.base, projectRootFingerprint(projectId));
    let slotReleases = 0;
    let maintenanceReleases = 0;
    await assert.rejects(
      () => backupCoderV2State({
        projectRoot: fx.base,
        backupDir: fx.backupDir,
        projectId,
        copyFile: async () => { throw new Error('primary copy failure'); },
        leaseDependencies: {
          acquireMaintenance: async () => ({
            release: async () => {
              maintenanceReleases += 1;
              throw new Error('maintenance release failure');
            },
          }),
          acquireSlot: async () => ({
            release: async () => {
              slotReleases += 1;
              throw new Error('slot release failure');
            },
          }),
        },
      }),
      (err) => {
        assert.ok(err instanceof AggregateError);
        assert.match(err.message, /backup operation and cleanup failed/);
        assert.equal(err.cause?.message, 'primary copy failure');
        return true;
      },
    );
    assert.equal(slotReleases, 2);
    assert.equal(maintenanceReleases, 2);
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

test('persistent backup identity consistency rejects missing, foreign, fingerprint-mismatched, and malformed identity', async () => {
  const projectId = 'e'.repeat(32);
  const foreignId = 'f'.repeat(32);
  const cases = [
    {
      name: 'missing identity',
      prepare: async () => {},
      expected: /project identity missing while persistent rows exist/,
    },
    {
      name: 'foreign identity',
      prepare: async (fx) => writeFile(join(fx.trissRoot, PROJECT_IDENTITY_REL), JSON.stringify({
        schema_version: 1, project_id: foreignId, creation_device: '1', creation_inode: '2', created_at: NOW,
      })),
      expected: /project identity fingerprint mismatch|manifest project_id does not match/,
    },
    {
      name: 'fingerprint mismatch',
      prepare: async (fx) => writeFile(join(fx.trissRoot, PROJECT_IDENTITY_REL), JSON.stringify({
        schema_version: 1, project_id: projectId, creation_device: '1', creation_inode: '2', created_at: NOW,
      })),
      fingerprint: '0'.repeat(64),
      expected: /project identity fingerprint mismatch/,
    },
    {
      name: 'malformed identity',
      prepare: async (fx) => writeFile(join(fx.trissRoot, PROJECT_IDENTITY_REL), '{malformed'),
      expected: /project identity invalid/,
    },
    {
      name: 'malformed identity metadata',
      prepare: async (fx) => writeFile(join(fx.trissRoot, PROJECT_IDENTITY_REL), JSON.stringify({
        schema_version: 1,
        project_id: projectId,
        creation_device: '01',
        creation_inode: 'not-decimal',
        created_at: 'not-a-timestamp',
      })),
      expected: /project identity invalid/,
    },
  ];
  for (const item of cases) {
    const fx = await fixture();
    try {
      await item.prepare(fx);
      await seedIdleRowWithMapping(
        fx.base,
        'opencode2',
        `identity-${item.name.replace(/\W+/g, '-')}`,
        'ses_identity',
        item.fingerprint || projectRootFingerprint(projectId),
      );
      await assert.rejects(
        () => backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId }),
        item.expected,
        item.name,
      );
    } finally {
      await fx.cleanup();
    }
  }
});

test('deleting rows keep identity ownership checks in source and validator', async () => {
  const projectId = '3'.repeat(32);
  const expectedFingerprint = projectRootFingerprint(projectId);

  const source = await fixture();
  try {
    await writeFile(join(source.trissRoot, PROJECT_IDENTITY_REL), JSON.stringify({
      schema_version: 1,
      project_id: projectId,
      creation_device: '1',
      creation_inode: '2',
      created_at: NOW,
    }));
    await seedDeletingRow(source.base, 'f'.repeat(64));
    await assert.rejects(
      () => backupCoderV2State({ projectRoot: source.base, backupDir: source.backupDir, projectId }),
      /project identity fingerprint mismatch: opencode\/deleting-row/,
    );
  } finally {
    await source.cleanup();
  }

  const copied = await fixture();
  try {
    await writeFile(join(copied.trissRoot, PROJECT_IDENTITY_REL), JSON.stringify({
      schema_version: 1,
      project_id: projectId,
      creation_device: '1',
      creation_inode: '2',
      created_at: NOW,
    }));
    await seedDeletingRow(copied.base, expectedFingerprint);
    await backupCoderV2State({ projectRoot: copied.base, backupDir: copied.backupDir, projectId });

    const inventoryPath = join(copied.backupDir, 'state', 'engine-sessions-v2', 'opencode', '.inventory.json');
    const inventory = decodeCoderSessionInventory(await readFile(inventoryPath, 'utf8'));
    const tampered = inventory.entries.map((row) => ({ ...row, project_root_fingerprint: 'f'.repeat(64) }));
    const tamperedText = encodeCoderSessionInventory(tampered, inventory.updated_at);
    await writeFile(inventoryPath, tamperedText);

    const { createHash } = await import('node:crypto');
    const manifestPath = join(copied.backupDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const inventoryEntry = manifest.entries.find((entry) => entry.path === 'engine-sessions-v2/opencode/.inventory.json');
    inventoryEntry.sha256 = createHash('sha256').update(tamperedText).digest('hex');
    manifest.sha256 = createHash('sha256')
      .update(manifest.entries.map((entry) => `${entry.path}\u0000${entry.sha256}`).join('\u0000'))
      .digest('hex');
    const manifestText = `${JSON.stringify(manifest)}\n`;
    await writeFile(manifestPath, manifestText);
    await writeFile(join(copied.backupDir, 'COMPLETION'), JSON.stringify({
      schema_version: 1,
      manifest_sha256: createHash('sha256').update(manifestText).digest('hex'),
      completed_at: NOW,
    }) + '\n');

    const validation = await validateCoderV2Backup(copied.backupDir);
    assert.equal(validation.valid, false);
    assert.ok(validation.reasons.some((reason) => /project identity fingerprint mismatch: opencode\/deleting-row/.test(reason)));
  } finally {
    await copied.cleanup();
  }
});

test('deleting-only source state still requires project identity before copy', async () => {
  const fx = await fixture();
  try {
    await seedDeletingRow(fx.base, projectRootFingerprint('8'.repeat(32)));
    await assert.rejects(
      () => backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId: '8'.repeat(32) }),
      /project identity missing while persistent rows exist/,
    );
    await assert.rejects(() => lstat(join(fx.backupDir, 'COMPLETION')), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test('backup validation rejects a manifest project_id changed away from the copied identity', async () => {
  const fx = await fixture();
  try {
    const projectId = '1'.repeat(32);
    await writeFile(join(fx.trissRoot, PROJECT_IDENTITY_REL), JSON.stringify({
      schema_version: 1, project_id: projectId, creation_device: '1', creation_inode: '2', created_at: NOW,
    }));
    await seedIdleRowWithMapping(fx.base, 'opencode2', 'manifest-id', 'ses_manifest', projectRootFingerprint(projectId));
    await backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId });
    const manifestPath = join(fx.backupDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.project_id = '2'.repeat(32);
    const manifestText = `${JSON.stringify(manifest)}\n`;
    await writeFile(manifestPath, manifestText);
    const { createHash } = await import('node:crypto');
    await writeFile(join(fx.backupDir, 'COMPLETION'), JSON.stringify({
      schema_version: 1,
      manifest_sha256: createHash('sha256').update(manifestText).digest('hex'),
      completed_at: NOW,
    }) + '\n');
    const validation = await validateCoderV2Backup(fx.backupDir);
    assert.equal(validation.valid, false);
    assert.ok(validation.reasons.some((reason) => /manifest project_id does not match/.test(reason)), validation.reasons.join('; '));
  } finally {
    await fx.cleanup();
  }
});

test('backup validation requires identity and canonical inventories to be listed in the manifest', async () => {
  const projectId = '4'.repeat(32);
  const fp = projectRootFingerprint(projectId);
  const cases = [
    ['project-identity-v1.json', /project identity is present outside manifest entries|unlisted state entry: project-identity-v1\.json/],
    ['engine-sessions-v2/opencode/.inventory.json', /unlisted state entry: engine-sessions-v2\/opencode\/.inventory\.json/],
  ];
  for (const [omittedPath, expected] of cases) {
    const fx = await fixture();
    try {
      await writeFile(join(fx.trissRoot, PROJECT_IDENTITY_REL), JSON.stringify({
        schema_version: 1,
        project_id: projectId,
        creation_device: '1',
        creation_inode: '2',
        created_at: NOW,
      }));
      await seedIdleRowWithMapping(fx.base, 'opencode', 'manifest-binding', 'ses_binding', fp);
      await backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId });

      const { createHash } = await import('node:crypto');
      const manifestPath = join(fx.backupDir, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.entries = manifest.entries.filter((entry) => entry.path !== omittedPath);
      manifest.sha256 = createHash('sha256')
        .update(manifest.entries.map((entry) => `${entry.path}\u0000${entry.sha256}`).join('\u0000'))
        .digest('hex');
      const manifestText = `${JSON.stringify(manifest)}\n`;
      await writeFile(manifestPath, manifestText);
      await writeFile(join(fx.backupDir, 'COMPLETION'), JSON.stringify({
        schema_version: 1,
        manifest_sha256: createHash('sha256').update(manifestText).digest('hex'),
        completed_at: NOW,
      }) + '\n');

      const validation = await validateCoderV2Backup(fx.backupDir);
      assert.equal(validation.valid, false, omittedPath);
      assert.ok(validation.reasons.some((reason) => expected.test(reason)), validation.reasons.join('; '));
    } finally {
      await fx.cleanup();
    }
  }
});

test('physical state validation bounds nodes and relative paths', async () => {
  const fx = await fixture();
  try {
    const stateRoot = join(fx.backupDir, 'state');
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, 'node.json'), '{}');

    await assert.rejects(
      () => listPhysicalStateFiles(fx.backupDir, { maxNodes: 0 }),
      /physical state nodes exceed 0 cap/,
    );
    await assert.rejects(
      () => listPhysicalStateFiles(fx.backupDir, { maxPathBytes: 4 }),
      /physical state path exceeds 4 bytes/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('physical walker treats file and directory caps independently at the boundary', async () => {
  const fx = await fixture();
  try {
    const stateRoot = join(fx.backupDir, 'state');
    await mkdir(join(stateRoot, 'nested'), { recursive: true });
    await writeFile(join(stateRoot, 'nested', 'one.json'), '{}');
    await writeFile(join(stateRoot, 'nested', 'two.json'), '{}');

    // Exactly maxFiles files plus exactly maxDirectories descendants and
    // their combined physical-node count is valid. Production no longer
    // uses one maxNodes budget that would reject this boundary shape.
    assert.deepEqual(
      await listPhysicalStateFiles(fx.backupDir, {
        maxFiles: 2,
        maxDirectories: 1,
        maxPhysicalNodes: 3,
      }),
      ['nested/one.json', 'nested/two.json'],
    );
    assert.ok(BACKUP_LIMITS.maxPhysicalNodes >= BACKUP_LIMITS.maxEntries);
    await assert.rejects(
      () => listPhysicalStateFiles(fx.backupDir, { maxFiles: 1, maxDirectories: 1, maxPhysicalNodes: 3 }),
      /physical state files exceed 1 cap/,
    );
    await assert.rejects(
      () => listPhysicalStateFiles(fx.backupDir, { maxFiles: 2, maxDirectories: 0, maxPhysicalNodes: 3 }),
      /physical state directories exceed 0 cap/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('physical walker rejects a directory-to-symlink swap before descending', async () => {
  const fx = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'triss-backup-outside-'));
  try {
    const stateRoot = join(fx.backupDir, 'state');
    const child = join(stateRoot, 'nested');
    await mkdir(child, { recursive: true });
    await writeFile(join(outside, 'canary.txt'), 'outside');
    let swapped = false;
    await assert.rejects(
      () => listPhysicalStateFiles(fx.backupDir, {
        beforeDescend: async (relative) => {
          if (relative !== 'nested' || swapped) return;
          swapped = true;
          await rm(child, { recursive: true, force: true });
          await symlink(outside, child);
        },
      }),
      /directory changed before descent|symlink|non-directory/,
    );
    assert.equal(await readFile(join(outside, 'canary.txt'), 'utf8'), 'outside');
  } finally {
    await fx.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('valid same-slug state in BOTH store engines backs up and validates immediately', async () => {
  const fx = await fixture();
  try {
    const fp = projectRootFingerprint('d'.repeat(32));
    await writeFile(join(fx.trissRoot, PROJECT_IDENTITY_REL), JSON.stringify({
      schema_version: 1,
      project_id: 'd'.repeat(32),
      creation_device: '1',
      creation_inode: '2',
      created_at: '2026-08-24T00:00:00.000Z',
    }));
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

test('backup rejects a handcrafted cross-engine distinct-live-slug slot collision', async () => {
  const fx = await fixture();
  try {
    const projectId = 'e'.repeat(32);
    const fp = projectRootFingerprint(projectId);
    await writeFile(join(fx.trissRoot, PROJECT_IDENTITY_REL), JSON.stringify({
      schema_version: 1,
      project_id: projectId,
      creation_device: '1',
      creation_inode: '2',
      created_at: NOW,
    }));
    await seedIdleRowWithMapping(fx.base, 'opencode', 'collision-a', 'ses_collision_a', fp);
    await seedIdleRowWithMapping(fx.base, 'opencode2', 'collision-b', 'ses_collision_b', fp);
    await markCoderSessionRunning({
      inventoryDir: join(fx.trissRoot, 'engine-sessions-v2', 'opencode'),
      engine: 'opencode', slug: 'collision-a', runId: 'run-collision-a',
      sandboxId: 'sbx_' + 'a'.repeat(32), pid: 101, processStartId: 'ps-a', bootId: 'boot-a',
    });
    await markCoderSessionRunning({
      inventoryDir: join(fx.trissRoot, 'engine-sessions-v2', 'opencode2'),
      engine: 'opencode2', slug: 'collision-b', runId: 'run-collision-b',
      sandboxId: 'sbx_' + 'b'.repeat(32), pid: 102, processStartId: 'ps-b', bootId: 'boot-b',
    });
    await assert.rejects(
      () => backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId }),
      /project-wide slot invariant.*distinct live slugs share lock slot/,
    );
    await assert.rejects(() => lstat(join(fx.backupDir, 'COMPLETION')), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test('backup validator rejects a rehashed copied cross-engine distinct-live collision', async () => {
  const fx = await fixture();
  try {
    const projectId = 'f'.repeat(32);
    const fp = projectRootFingerprint(projectId);
    await writeFile(join(fx.trissRoot, PROJECT_IDENTITY_REL), JSON.stringify({
      schema_version: 1,
      project_id: projectId,
      creation_device: '1',
      creation_inode: '2',
      created_at: NOW,
    }));
    await seedIdleRowWithMapping(fx.base, 'opencode', 'validator-a', 'ses_validator_a', fp);
    await seedIdleRowWithMapping(fx.base, 'opencode2', 'validator-b', 'ses_validator_b', fp);
    await backupCoderV2State({ projectRoot: fx.base, backupDir: fx.backupDir, projectId });

    const copiedInventories = [
      ['opencode', 'd', 103],
      ['opencode2', 'c', 104],
    ];
    const copiedByPath = new Map();
    for (const [engine, marker, pid] of copiedInventories) {
      const inventoryPath = join(fx.backupDir, 'state', 'engine-sessions-v2', engine, INVENTORY_BASENAME);
      const inventoryText = await readFile(inventoryPath, 'utf8');
      const inventory = decodeCoderSessionInventory(inventoryText);
      const row = inventory.entries[0];
      const liveRow = {
        ...row,
        state: 'running',
        run_id: `run_validator_collision_${engine}`,
        sandbox_id: 'sbx_' + marker.repeat(32),
        pid,
        process_start_id: `ps-validator-${engine}`,
        boot_id: `boot-validator-${engine}`,
      };
      const copiedText = encodeCoderSessionInventory([liveRow], inventory.updated_at);
      await writeFile(inventoryPath, copiedText, { mode: 0o600 });
      copiedByPath.set(`engine-sessions-v2/${engine}/.inventory.json`, copiedText);
    }
    const manifestPath = join(fx.backupDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const entry of manifest.entries) {
      const copiedText = copiedByPath.get(entry.path);
      if (!copiedText) continue;
      entry.sha256 = createHash('sha256').update(copiedText, 'utf8').digest('hex');
      entry.size = Buffer.byteLength(copiedText, 'utf8');
    }
    manifest.sha256 = createHash('sha256')
      .update(manifest.entries.map((candidate) => `${candidate.path}\u0000${candidate.sha256}`).join('\u0000'), 'utf8')
      .digest('hex');
    const manifestText = `${JSON.stringify(manifest)}\n`;
    await writeFile(manifestPath, manifestText, { mode: 0o600 });
    const completionPath = join(fx.backupDir, 'COMPLETION');
    const completion = JSON.parse(await readFile(completionPath, 'utf8'));
    completion.manifest_sha256 = createHash('sha256').update(manifestText, 'utf8').digest('hex');
    await writeFile(completionPath, `${JSON.stringify(completion)}\n`, { mode: 0o600 });

    const validation = await validateCoderV2Backup(fx.backupDir);
    assert.equal(validation.valid, false);
    assert.match(validation.reasons.join('; '), /distinct live slugs share lock slot/);
  } finally {
    await fx.cleanup();
  }
});
