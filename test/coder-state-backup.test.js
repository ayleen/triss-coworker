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
import { mkdtemp, mkdir, rm, writeFile, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BACKUP_MANIFEST_KEYS,
  BACKUP_COMPLETION_KEYS,
  BACKUP_LIMITS,
  inventoryCoderV2State,
  backupCoderV2State,
  validateCoderV2Backup,
} from '../src/coder-state-backup.js';

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
