/**
 * coder-result-transitions.test.js — Package 5A (Atomic 20A): retained-result
 * transitions and deletion.
 *
 * RED/GREEN: node --test test/coder-result-transitions.test.js
 *
 * Covers Section 6.3 result quota / immutable provenance / deletion phases
 * of docs/reliable-delegation-contract-plan.md: all three result-quota
 * outcomes, 1 GiB reservation / 3 GiB payload budget + 1 GiB headroom,
 * concurrent admission, immutable freeze/verify, dual-form publication,
 * deletion phases, and registry recovery.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareCoderResultStoreQuota } from '../src/coder-write-quota.js';
import { encodeResultState } from '../src/coder-result-registry-codec.js';
import {
  RESULT_PAYLOAD_BUDGET,
  RESULT_HEADROOM,
  RESULT_RESERVATION_BYTES,
  RESULT_QUOTA_REQUIRED_CODE,
  RESULT_CAP_CODE,
  RESULT_STATE,
  RESULT_DELETE_PHASE,
  assertCoderNamespaceAvailable,
  reserveCoderResultCapacity,
  releaseCoderResultReservation,
  publishCoderRetainedResult,
  beginCoderResultDeletion,
  listCoderRetainedResults,
  recoverCoderResultRegistry,
} from '../src/coder-result-transitions.js';

const NOW = '2026-08-13T10:00:00.000Z';

function resultRecord(runId = 'run-abc123', overrides = {}) {
  return {
    schema_version: 1,
    kind: 'result',
    run_id: runId,
    engine: 'opencode',
    session_slug: 'task-a',
    project_root_fingerprint: 'f'.repeat(64),
    branch_ref: `refs/heads/coder-result-v1/${'f'.repeat(64)}/opencode/${runId}`,
    repository_object_format: 'sha1',
    base_commit_oid: 'a'.repeat(40),
    repository_fingerprint: `sha256:${'b'.repeat(64)}`,
    worktree_parent_realpath: `/repo/.triss/coder-results-v1/runs/${runId}`,
    worktree_basename: 'worktree',
    worktree_fingerprint: `sha256:${'c'.repeat(64)}`,
    base_snapshot_id: `sha256:${'d'.repeat(64)}`,
    post_snapshot_id: `sha256:${'e'.repeat(64)}`,
    source_coder_state_sha256: '0'.repeat(64),
    published_at: NOW,
    ...overrides,
  };
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-result-tx-'));
  const runDir = join(base, 'runs', 'run-abc123');
  await mkdir(runDir, { recursive: true });
  return {
    base,
    runDir,
    runDirs: [runDir, join(base, 'runs', 'run-other')],
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

// ─── quota outcomes ──────────────────────────────────────────────────────────

test('the 1 GiB reservation / 3 GiB budget + 1 GiB headroom contract is exact', () => {
  assert.equal(RESULT_RESERVATION_BYTES, 1024 * 1024 * 1024);
  assert.equal(RESULT_PAYLOAD_BUDGET, 3 * 1024 * 1024 * 1024);
  assert.equal(RESULT_HEADROOM, 1024 * 1024 * 1024);
  assert.deepEqual(RESULT_STATE, ['reserved', 'retained', 'deleting']);
  assert.deepEqual(RESULT_DELETE_PHASE, ['worktree_tombstoned', 'worktree_removed', 'branch_removed', 'state_removed']);
});

test('three concurrent 1 GiB reservations fit; the fourth fails with TRISS_CODER_RESULT_CAP', async () => {
  const quota = prepareCoderResultStoreQuota();
  quota.capability = 'enforced';
  for (let i = 0; i < 3; i += 1) {
    const r = await reserveCoderResultCapacity(quota, { runId: `run-${i}` });
    assert.equal(r.reservation.bytes, RESULT_RESERVATION_BYTES);
  }
  await assert.rejects(
    () => reserveCoderResultCapacity(quota, { runId: 'run-4' }),
    (err) => {
      assert.match(err.message, new RegExp(RESULT_CAP_CODE));
      return true;
    },
  );
  // Release frees capacity: the fourth admission now fits.
  await releaseCoderResultReservation(quota, { runId: 'run-0' });
  const again = await reserveCoderResultCapacity(quota, { runId: 'run-4' });
  assert.equal(again.reservation.runId, 'run-4');
});

test('an unavailable quota fails with TRISS_CODER_RESULT_QUOTA_REQUIRED', async () => {
  const quota = { capability: 'unavailable' };
  await assert.rejects(
    () => reserveCoderResultCapacity(quota, { runId: 'run-x' }),
    new RegExp(RESULT_QUOTA_REQUIRED_CODE),
  );
  await assert.rejects(
    () => reserveCoderResultCapacity(undefined, { runId: 'run-x' }),
    new RegExp(RESULT_QUOTA_REQUIRED_CODE),
  );
});

// ─── namespace assertion ─────────────────────────────────────────────────────

test('assertCoderNamespaceAvailable passes on a clean namespace and fails on collision', async () => {
  await assertCoderNamespaceAvailable({ runId: 'run-1', probe: async () => false });
  await assert.rejects(
    () => assertCoderNamespaceAvailable({ runId: 'run-1', probe: async () => true }),
    new RegExp(RESULT_CAP_CODE),
  );
  await assert.rejects(() => assertCoderNamespaceAvailable({ runId: '' }), TypeError);
});

// ─── publication with dual-form recovery ─────────────────────────────────────

test('publishCoderRetainedResult freezes a canonical record and is idempotent', async () => {
  const fx = await fixture();
  try {
    const record = resultRecord();
    const published = await publishCoderRetainedResult({ runDir: fx.runDir, record });
    assert.deepEqual(published, record);
    const text = await readFile(join(fx.runDir, 'result-state.json'), 'utf8');
    assert.equal(text, encodeResultState(record));

    // Re-publication with an identical record advances without re-running.
    const again = await publishCoderRetainedResult({ runDir: fx.runDir, record });
    assert.deepEqual(again, record);

    // A differing candidate fails closed (immutable provenance).
    await assert.rejects(
      () => publishCoderRetainedResult({ runDir: fx.runDir, record: resultRecord('run-abc123', { session_slug: 'other' }) }),
      (err) => {
        assert.equal(err.code, 'RESULT_CONFLICT');
        return true;
      },
    );
  } finally {
    await fx.cleanup();
  }
});

test('invalid publication records fail closed', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      () => publishCoderRetainedResult({ runDir: fx.runDir, record: { kind: 'session' } }),
      /failed canonical validation/,
    );
  } finally {
    await fx.cleanup();
  }
});

// ─── deletion and recovery ───────────────────────────────────────────────────

test('beginCoderResultDeletion marks deleting and is idempotent; recover removes when artifacts are gone', async () => {
  const fx = await fixture();
  try {
    await publishCoderRetainedResult({ runDir: fx.runDir, record: resultRecord() });
    const deleting = await beginCoderResultDeletion({ runDir: fx.runDir, runId: 'run-abc123' });
    assert.equal(deleting.delete_phase, RESULT_DELETE_PHASE[0]);
    assert.equal(deleting.run_id, 'run-abc123');
    // Idempotent second begin.
    const again = await beginCoderResultDeletion({ runDir: fx.runDir, runId: 'run-abc123' });
    assert.equal(again.delete_phase, RESULT_DELETE_PHASE[0]);

    // Recovery with artifacts still present: resume later (recovered), kept.
    const kept = await recoverCoderResultRegistry({
      runDirs: [fx.runDir],
      artifactsGone: async () => false,
    });
    assert.equal(kept.recovered, 1);
    assert.equal(kept.removed, 0);

    // Recovery once artifacts are gone: removed.
    const removed = await recoverCoderResultRegistry({
      runDirs: [fx.runDir],
      artifactsGone: async () => true,
    });
    assert.equal(removed.removed, 1);
  } finally {
    await fx.cleanup();
  }
});

test('listCoderRetainedResults returns the bounded projection', async () => {
  const fx = await fixture();
  try {
    await publishCoderRetainedResult({ runDir: fx.runDir, record: resultRecord() });
    const otherDir = join(fx.base, 'runs', 'run-other');
    await mkdir(otherDir, { recursive: true });
    await publishCoderRetainedResult({ runDir: otherDir, record: resultRecord('run-other') });
    const list = await listCoderRetainedResults({ runDirs: [otherDir, fx.runDir] });
    assert.equal(list.length, 2);
    assert.equal(list[0].run_id, 'run-abc123');
    assert.equal(list[1].run_id, 'run-other');
    assert.deepEqual(Object.keys(list[0]).sort(), ['engine', 'published_at', 'run_id', 'session_slug', 'state']);
  } finally {
    await fx.cleanup();
  }
});

test('recoverCoderResultRegistry keeps retained records and ignores absent dirs', async () => {
  const fx = await fixture();
  try {
    await publishCoderRetainedResult({ runDir: fx.runDir, record: resultRecord() });
    const result = await recoverCoderResultRegistry({
      runDirs: [fx.runDir, join(fx.base, 'runs', 'absent-dir')],
      artifactsGone: async () => true,
    });
    assert.equal(result.removed, 0);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].state, 'retained');
  } finally {
    await fx.cleanup();
  }
});
