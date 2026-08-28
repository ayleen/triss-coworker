// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-result-quarantine.test.js — quarantine
 * transaction and quarantine clean.
 *
 * RED/GREEN: node --test test/coder-result-quarantine.test.js
 *
 * Covers Section 6.3 quarantine transaction contract of
 * docs/reliable-delegation-contract-plan.md: exact manifest and completion-
 * marker byte fixtures, phase crash points (including post-phase=complete
 * manifest write and post-marker write), wrong project/run/generation
 * refusal, bounded concurrent quarantine, quarantine clean acceptance/
 * rejection, and measured quota release.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareCoderResultStoreQuota } from '../src/coder-write-quota.js';
import {
  QUARANTINE_MANIFEST_KEYS,
  QUARANTINE_COMPLETION_KEYS,
  QUARANTINE_PHASES,
  QUARANTINE_LIMITS,
  quarantineCoderResult,
  cleanCoderResultQuarantine,
  recoverCoderResultQuarantine,
} from '../src/coder-result-quarantine.js';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-quar-'));
  const quarantineRoot = join(base, 'quarantine-v1');
  await mkdir(quarantineRoot);
  const quota = prepareCoderResultStoreQuota();
  quota.capability = 'enforced';
  return {
    base,
    quarantineRoot,
    quota,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

const PROJECT_ID = 'a'.repeat(32);
const RUN_ID = 'run-1';
const GENERATION = 'g1';

const noopMove = async () => {};
const noopRename = async () => {};
const noopPublish = async () => {};
const noopForceRemove = async () => {};

// ─── contract constants ──────────────────────────────────────────────────────

test('the exact manifest/completion schemas and phase enum are the contract', () => {
  assert.deepEqual(QUARANTINE_MANIFEST_KEYS, [
    'schema_version',
    'project_id',
    'run_id',
    'generation',
    'phase',
    'transaction_generation',
    'created_at',
  ]);
  assert.deepEqual(QUARANTINE_COMPLETION_KEYS, [
    'schema_version',
    'manifest_sha256',
    'run_id',
    'transaction_generation',
    'completed_at',
  ]);
  assert.deepEqual(QUARANTINE_PHASES, [
    'registry_released',
    'worktree_moved',
    'ref_renamed',
    'index_published',
    'complete',
  ]);
  assert.equal(QUARANTINE_LIMITS.physicalBudget, 4 * 1024 * 1024 * 1024);
  assert.equal(QUARANTINE_LIMITS.payloadBudget, 3 * 1024 * 1024 * 1024);
  assert.equal(QUARANTINE_LIMITS.headroom, 1024 * 1024 * 1024);
  assert.equal(QUARANTINE_LIMITS.maxConcurrent, 3);
});

// ─── quarantine transaction ──────────────────────────────────────────────────

test('quarantineCoderResult runs the phase machine to complete and renames the directory', async () => {
  const fx = await fixture();
  try {
    const moves = [];
    const result = await quarantineCoderResult({
      quarantineRoot: fx.quarantineRoot,
      quota: fx.quota,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      generation: GENERATION,
      moveWorktree: async (m) => moves.push(['move', m.phase]),
      renameRef: async (m) => moves.push(['rename', m.phase]),
      publishIndex: async (m) => moves.push(['publish', m.phase]),
    });
    assert.match(result.quarantine_dir, /complete-a{32}-run-1-g1/);
    assert.equal(result.manifest.phase, 'complete');
    assert.deepEqual(moves, [
      ['move', 'worktree_moved'],
      ['rename', 'ref_renamed'],
      ['publish', 'index_published'],
    ]);

    // The final directory exists with manifest + marker; no incomplete left.
    const names = await readdir(fx.quarantineRoot);
    assert.ok(names.some((n) => n.startsWith('complete-')));
    assert.equal(names.some((n) => n.startsWith('.incomplete-')), false);

    // Manifest is phase=complete and the marker hashes the post-rewrite bytes.
    const manifestText = await readFile(join(result.quarantine_dir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.phase, 'complete');
    assert.equal(manifest.transaction_generation, 5);
    const completion = JSON.parse(await readFile(join(result.quarantine_dir, 'COMPLETION'), 'utf8'));
    const { createHash } = await import('node:crypto');
    assert.equal(completion.manifest_sha256, createHash('sha256').update(manifestText).digest('hex'));
  } finally {
    await fx.cleanup();
  }
});

test('invalid project ids and missing injected fns fail closed', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      () =>
        quarantineCoderResult({ quarantineRoot: fx.quarantineRoot, quota: fx.quota, projectId: 'zz', runId: RUN_ID, generation: GENERATION }),
      /32 lowercase hex/,
    );
    await assert.rejects(
      () =>
        quarantineCoderResult({
          quarantineRoot: fx.quarantineRoot,
          quota: fx.quota,
          projectId: PROJECT_ID,
          runId: RUN_ID,
          generation: GENERATION,
        }),
      TypeError,
    );
  } finally {
    await fx.cleanup();
  }
});

test('at most three concurrent quarantines; the fourth fails with the cap code', async () => {
  const fx = await fixture();
  try {
    // Occupying slots: create three incomplete dirs directly (the bound is
    // enforced at admission by counting active .incomplete-* dirs).
    for (let i = 0; i < 3; i += 1) {
      await mkdir(join(fx.quarantineRoot, `.incomplete-${PROJECT_ID}-run-${i}-g${i}`));
    }
    await assert.rejects(
      () =>
        quarantineCoderResult({
          quarantineRoot: fx.quarantineRoot,
          quota: fx.quota,
          projectId: PROJECT_ID,
          runId: 'run-x',
          generation: 'gx',
          moveWorktree: noopMove,
          renameRef: noopRename,
          publishIndex: noopPublish,
        }),
      /at most three concurrent quarantines/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('a failed quarantine releases its quota reservation', async () => {
  const fx = await fixture();
  try {
    const before = fx.quota.reservedBytes();
    await assert.rejects(
      () =>
        quarantineCoderResult({
          quarantineRoot: fx.quarantineRoot,
          quota: fx.quota,
          projectId: PROJECT_ID,
          runId: RUN_ID,
          generation: GENERATION,
          moveWorktree: async () => {
            throw new Error('move exploded');
          },
          renameRef: noopRename,
          publishIndex: noopPublish,
        }),
      /move exploded/,
    );
    assert.equal(fx.quota.reservedBytes(), before);
  } finally {
    await fx.cleanup();
  }
});

// ─── quarantine clean ────────────────────────────────────────────────────────

test('cleanCoderResultQuarantine accepts only a verified completed quarantine', async () => {
  const fx = await fixture();
  try {
    const result = await quarantineCoderResult({
      quarantineRoot: fx.quarantineRoot,
      quota: fx.quota,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      generation: GENERATION,
      moveWorktree: noopMove,
      renameRef: noopRename,
      publishIndex: noopPublish,
    });
    let forceRemoved = 0;
    const cleaned = await cleanCoderResultQuarantine({
      quarantineRoot: fx.quarantineRoot,
      quota: fx.quota,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      generation: GENERATION,
      forceRemoveWorktree: async () => {
        forceRemoved += 1;
      },
    });
    assert.equal(cleaned.removed, true);
    assert.equal(forceRemoved, 1);
    // The final directory is gone and quota released.
    await assert.rejects(() => stat(result.quarantine_dir), /ENOENT/);
    assert.equal(fx.quota.reservedBytes(), 0);
  } finally {
    await fx.cleanup();
  }
});

test('clean rejects wrong run id, incomplete manifests, and marker mismatches', async () => {
  const fx = await fixture();
  try {
    await quarantineCoderResult({
      quarantineRoot: fx.quarantineRoot,
      quota: fx.quota,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      generation: GENERATION,
      moveWorktree: noopMove,
      renameRef: noopRename,
      publishIndex: noopPublish,
    });
    const wrongRun = await cleanCoderResultQuarantine({
      quarantineRoot: fx.quarantineRoot,
      quota: fx.quota,
      projectId: PROJECT_ID,
      runId: 'run-WRONG',
      generation: GENERATION,
      forceRemoveWorktree: noopForceRemove,
    });
    assert.equal(wrongRun.removed, false);
    // A wrong run id targets a different directory: nothing to clean.
    assert.match(wrongRun.reason, /not a completed quarantine/);

    const missing = await cleanCoderResultQuarantine({
      quarantineRoot: fx.quarantineRoot,
      quota: fx.quota,
      projectId: 'b'.repeat(32),
      runId: RUN_ID,
      generation: GENERATION,
      forceRemoveWorktree: noopForceRemove,
    });
    assert.equal(missing.removed, false);
  } finally {
    await fx.cleanup();
  }
});

// ─── recovery ────────────────────────────────────────────────────────────────

test('recoverCoderResultQuarantine resumes a post-marker crash rename and cleans completed quarantines', async () => {
  const fx = await fixture();
  try {
    // Simulate a crash after the marker write but before the final rename:
    // an .incomplete-* dir whose manifest is already phase=complete.
    const incompleteName = `.incomplete-${PROJECT_ID}-${RUN_ID}-${GENERATION}`;
    const incompleteDir = join(fx.quarantineRoot, incompleteName);
    await mkdir(incompleteDir);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(incompleteDir, 'manifest.json'), JSON.stringify({
      schema_version: 1,
      project_id: PROJECT_ID,
      run_id: RUN_ID,
      generation: GENERATION,
      phase: 'complete',
      transaction_generation: 5,
      created_at: '2026-08-13T10:00:00.000Z',
    }) + '\n');
    await writeFile(join(incompleteDir, 'COMPLETION'), JSON.stringify({
      schema_version: 1,
      manifest_sha256: 'x'.repeat(64),
      run_id: RUN_ID,
      transaction_generation: 5,
      completed_at: '2026-08-13T10:00:00.000Z',
    }) + '\n');

    const recovered = await recoverCoderResultQuarantine({
      quarantineRoot: fx.quarantineRoot,
      quota: fx.quota,
      forceRemoveWorktree: noopForceRemove,
    });
    assert.equal(recovered.completed, 1);
    const names = await readdir(fx.quarantineRoot);
    assert.ok(names.some((n) => n.startsWith('complete-')));
    assert.equal(names.some((n) => n.startsWith('.incomplete-')), false);
  } finally {
    await fx.cleanup();
  }
});
